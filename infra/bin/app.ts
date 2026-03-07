#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ChatbotPlatformStack } from "../lib/chatbot-stack.js";

const app = new cdk.App();

new ChatbotPlatformStack(app, "ChatbotPlatformStack", {
	env: {
		account: "017263836161",
		region: "eu-central-1",
	},
	domainName: "chat.pi-agents.nl",
	hostedZoneName: "pi-agents.nl",
	hostedZoneId: "Z0897381PG8CDRSBMFMM",
	githubRepo: "ianshan0915/pi-agent-chatbot-platform",
});
