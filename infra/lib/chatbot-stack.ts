import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ses from "aws-cdk-lib/aws-ses";
import type { Construct } from "constructs";

export interface ChatbotPlatformStackProps extends cdk.StackProps {
	/** Full domain for the app, e.g. "chat.example.com" */
	domainName?: string;
	/** Root hosted zone name, e.g. "example.com" */
	hostedZoneName?: string;
	/** Email "From" address for verification/invite emails, e.g. "noreply@example.com" */
	emailFromAddress?: string;
}

export class ChatbotPlatformStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props: ChatbotPlatformStackProps) {
		super(scope, id, props);

		// ----------------------------------------------------------------
		// VPC — 2 AZs, public + private subnets (NAT gateway for outbound)
		// ----------------------------------------------------------------
		const vpc = new ec2.Vpc(this, "Vpc", {
			maxAzs: 2,
			natGateways: 1, // Keep costs low; 1 NAT is fine for non-HA start
			subnetConfiguration: [
				{ name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
				{ name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
			],
		});

		// ----------------------------------------------------------------
		// S3 — file & skill storage
		// ----------------------------------------------------------------
		const storageBucket = new s3.Bucket(this, "StorageBucket", {
			bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
			encryption: s3.BucketEncryption.S3_MANAGED,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			removalPolicy: cdk.RemovalPolicy.RETAIN, // Don't delete user files on stack destroy
			versioned: true,
			lifecycleRules: [
				{
					// Clean up incomplete multipart uploads
					abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
				},
			],
		});

		// ----------------------------------------------------------------
		// Secrets Manager — application secrets
		// ----------------------------------------------------------------
		const appSecrets = new secretsmanager.Secret(this, "AppSecrets", {
			secretName: "chatbot-platform/app-secrets",
			description: "Chatbot Platform application secrets",
			generateSecretString: {
				secretStringTemplate: JSON.stringify({
					JWT_SECRET: "",
					ENCRYPTION_ROOT_KEY: "",
				}),
				generateStringKey: "JWT_SECRET",
				excludePunctuation: true,
				passwordLength: 64,
			},
		});

		// ----------------------------------------------------------------
		// RDS PostgreSQL — free tier eligible
		// ----------------------------------------------------------------
		const dbCredentials = rds.Credentials.fromGeneratedSecret("chatbot", {
			secretName: "chatbot-platform/db-credentials",
		});

		const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
			vpc,
			description: "Security group for RDS PostgreSQL",
			allowAllOutbound: false,
		});

		const database = new rds.DatabaseInstance(this, "Database", {
			engine: rds.DatabaseInstanceEngine.postgres({
				version: rds.PostgresEngineVersion.VER_16,
			}),
			instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
			vpc,
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			securityGroups: [dbSecurityGroup],
			credentials: dbCredentials,
			databaseName: "chatbot_platform",
			allocatedStorage: 20,
			maxAllocatedStorage: 50,
			storageEncrypted: true,
			multiAz: false, // Single AZ for cost savings
			backupRetention: cdk.Duration.days(7),
			deletionProtection: false, // Set to true for production
			removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
		});

		// ----------------------------------------------------------------
		// ECR — container registry
		// ----------------------------------------------------------------
		const repository = new ecr.Repository(this, "AppRepository", {
			repositoryName: "chatbot-platform",
			removalPolicy: cdk.RemovalPolicy.RETAIN,
			lifecycleRules: [
				{
					description: "Keep last 10 images",
					maxImageCount: 10,
				},
			],
		});

		// ----------------------------------------------------------------
		// ECS Cluster
		// ----------------------------------------------------------------
		const cluster = new ecs.Cluster(this, "Cluster", {
			vpc,
			containerInsights: true,
		});

		// ----------------------------------------------------------------
		// Route 53 + ACM (conditional on domain config)
		// ----------------------------------------------------------------
		let hostedZone: route53.IHostedZone | undefined;
		let certificate: acm.ICertificate | undefined;

		if (props.domainName && props.hostedZoneName) {
			// Keep the CDK-managed HostedZone to preserve CloudFormation references.
			// Switching to fromHostedZoneAttributes breaks the DNS RecordSet replacement.
			hostedZone = new route53.HostedZone(this, "HostedZone", {
				zoneName: props.hostedZoneName,
			});

			certificate = new acm.Certificate(this, "Certificate", {
				domainName: props.domainName,
				validation: acm.CertificateValidation.fromDns(hostedZone),
			});
		}

		// ----------------------------------------------------------------
		// SES — email delivery (verification emails, invites, job results)
		// ----------------------------------------------------------------
		// SES email identity for the domain (auto-adds DKIM DNS records if hostedZone exists)
		if (props.hostedZoneName && hostedZone) {
			new ses.EmailIdentity(this, "SesIdentity", {
				identity: ses.Identity.publicHostedZone(hostedZone as route53.IPublicHostedZone),
			});
		}

		// IAM user for SES SMTP credentials.
		// After deploy: generate SMTP credentials in IAM console for this user,
		// then store them in Secrets Manager under chatbot-platform/smtp-credentials.
		const smtpUser = new iam.User(this, "SmtpUser", {
			userName: "chatbot-platform-smtp",
		});
		smtpUser.addToPolicy(new iam.PolicyStatement({
			effect: iam.Effect.ALLOW,
			actions: ["ses:SendRawEmail"],
			resources: ["*"],
		}));

		const smtpSecrets = new secretsmanager.Secret(this, "SmtpSecrets", {
			secretName: "chatbot-platform/smtp-credentials",
			description: "SES SMTP credentials — update after generating in IAM console",
			generateSecretString: {
				secretStringTemplate: JSON.stringify({
					username: "REPLACE_WITH_SES_SMTP_USERNAME",
					password: "REPLACE_WITH_SES_SMTP_PASSWORD",
				}),
				generateStringKey: "_placeholder",
			},
		});

		// ----------------------------------------------------------------
		// Fargate Task Definition
		// ----------------------------------------------------------------
		const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
			memoryLimitMiB: 4096,
			cpu: 2048, // 2 vCPU — needed for child pi processes
		});

		// Grant S3 access to the task role
		storageBucket.grantReadWrite(taskDefinition.taskRole);

		// Grant Secrets Manager read access
		appSecrets.grantRead(taskDefinition.taskRole);

		// Build DATABASE_URL from RDS secret
		const dbSecret = database.secret!;

		const logGroup = new logs.LogGroup(this, "AppLogGroup", {
			logGroupName: "/ecs/chatbot-platform",
			retention: logs.RetentionDays.ONE_MONTH,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		const container = taskDefinition.addContainer("app", {
			// Initial deployment uses a placeholder; after first `docker push` to ECR,
			// update to: ecs.ContainerImage.fromEcrRepository(repository, "latest")
			image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
			logging: ecs.LogDrivers.awsLogs({
				logGroup,
				streamPrefix: "app",
			}),
			environment: {
				NODE_ENV: "production",
				PORT: "3001",
				STORAGE_BACKEND: "s3",
				S3_BUCKET_NAME: storageBucket.bucketName,
				AWS_REGION: this.region,
				PROCESS_POOL_MAX: "30",
				PROCESS_IDLE_TIMEOUT_MS: "600000",
				ALLOWED_ORIGINS: props.domainName ? `https://${props.domainName}` : "",
				// SES SMTP (region-specific endpoint)
				SMTP_HOST: `email-smtp.${this.region}.amazonaws.com`,
				SMTP_PORT: "587",
				SMTP_SECURE: "false",
				EMAIL_FROM_ADDRESS: props.emailFromAddress || (props.domainName ? `noreply@${props.hostedZoneName || props.domainName}` : ""),
				APP_URL: props.domainName ? `https://${props.domainName}` : "",
				REGISTRATION_MODE: "open",
			},
			secrets: {
				// Inject individual secret fields as env vars
				JWT_SECRET: ecs.Secret.fromSecretsManager(appSecrets, "JWT_SECRET"),
				ENCRYPTION_ROOT_KEY: ecs.Secret.fromSecretsManager(appSecrets, "ENCRYPTION_ROOT_KEY"),
				// RDS credentials — construct DATABASE_URL in the container
				DB_HOST: ecs.Secret.fromSecretsManager(dbSecret, "host"),
				DB_PORT: ecs.Secret.fromSecretsManager(dbSecret, "port"),
				DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, "username"),
				DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
				DB_NAME: ecs.Secret.fromSecretsManager(dbSecret, "dbname"),
				// SES SMTP credentials
				SMTP_USER: ecs.Secret.fromSecretsManager(smtpSecrets, "username"),
				SMTP_PASSWORD: ecs.Secret.fromSecretsManager(smtpSecrets, "password"),
			},
			portMappings: [{ containerPort: 3001, protocol: ecs.Protocol.TCP }],
			healthCheck: {
				command: ["CMD-SHELL", "curl -f http://localhost:3001/healthz || exit 1"],
				interval: cdk.Duration.seconds(30),
				timeout: cdk.Duration.seconds(5),
				retries: 3,
				startPeriod: cdk.Duration.seconds(60),
			},
		});

		// ----------------------------------------------------------------
		// Fargate Service + ALB
		// ----------------------------------------------------------------
		const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
			this,
			"FargateService",
			{
				cluster,
				taskDefinition,
				desiredCount: 1,
				publicLoadBalancer: true,
				assignPublicIp: false, // Task in private subnet, outbound via NAT
				// Domain configuration (if provided)
				...(hostedZone && certificate && props.domainName
					? {
							domainName: props.domainName,
							domainZone: hostedZone,
							certificate,
							redirectHTTP: true,
						}
					: {}),
				// Health check configuration
				healthCheckGracePeriod: cdk.Duration.seconds(120),
			},
		);

		// Configure ALB target group for WebSocket support
		fargateService.targetGroup.configureHealthCheck({
			path: "/healthz",
			healthyHttpCodes: "200",
			interval: cdk.Duration.seconds(30),
			timeout: cdk.Duration.seconds(5),
		});

		// Enable stickiness for WebSocket connections
		fargateService.targetGroup.enableCookieStickiness(cdk.Duration.days(1));

		// Speed up deployments — WS clients auto-reconnect, no need for long drain
		fargateService.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

		// ALB idle timeout — WebSocket connections can be long-lived
		fargateService.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "3600");

		// Allow Fargate tasks to connect to RDS
		dbSecurityGroup.addIngressRule(
			fargateService.service.connections.securityGroups[0],
			ec2.Port.tcp(5432),
			"Allow Fargate tasks to connect to PostgreSQL",
		);

		// ----------------------------------------------------------------
		// Outputs
		// ----------------------------------------------------------------
		new cdk.CfnOutput(this, "LoadBalancerDNS", {
			value: fargateService.loadBalancer.loadBalancerDnsName,
			description: "ALB DNS name (use this if no custom domain)",
		});

		new cdk.CfnOutput(this, "EcrRepositoryUri", {
			value: repository.repositoryUri,
			description: "ECR repository URI for docker push",
		});

		new cdk.CfnOutput(this, "StorageBucketName", {
			value: storageBucket.bucketName,
			description: "S3 bucket for file storage",
		});

		new cdk.CfnOutput(this, "DatabaseEndpoint", {
			value: database.instanceEndpoint.hostname,
			description: "RDS PostgreSQL endpoint",
		});

		new cdk.CfnOutput(this, "AppSecretsArn", {
			value: appSecrets.secretArn,
			description: "Secrets Manager ARN — update ENCRYPTION_ROOT_KEY after deploy",
		});

		if (hostedZone) {
			const ns = (hostedZone as route53.HostedZone).hostedZoneNameServers;
			if (ns) {
				new cdk.CfnOutput(this, "NameServers", {
					value: cdk.Fn.join(", ", ns),
					description: "Route 53 name servers — point your domain registrar here",
				});
			}
		}

		if (props.domainName) {
			new cdk.CfnOutput(this, "AppUrl", {
				value: `https://${props.domainName}`,
				description: "Application URL",
			});
		}

		new cdk.CfnOutput(this, "SmtpUserName", {
			value: smtpUser.userName,
			description: "IAM user for SES SMTP — generate SMTP credentials in IAM console",
		});

		new cdk.CfnOutput(this, "SmtpSecretsArn", {
			value: smtpSecrets.secretArn,
			description: "Secrets Manager ARN — store SES SMTP credentials here",
		});

		new cdk.CfnOutput(this, "SmtpEndpoint", {
			value: `email-smtp.${this.region}.amazonaws.com:587`,
			description: "SES SMTP endpoint",
		});
	}
}
