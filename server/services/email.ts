/**
 * Email Service: send verification and invite emails via SMTP.
 */

import nodemailer from "nodemailer";

function createTransport() {
	const host = process.env.SMTP_HOST;
	if (!host) throw new Error("SMTP_HOST not configured");

	return nodemailer.createTransport({
		host,
		port: parseInt(process.env.SMTP_PORT || "587", 10),
		secure: process.env.SMTP_SECURE === "true",
		auth: process.env.SMTP_USER
			? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
			: undefined,
	});
}

function getFromAddress(): string {
	return process.env.EMAIL_FROM_ADDRESS || "noreply@chatbot-platform.local";
}

export async function sendVerificationEmail(to: string, verificationUrl: string): Promise<void> {
	const transporter = createTransport();

	await transporter.sendMail({
		from: getFromAddress(),
		to,
		subject: "Verify your email address",
		text: `Welcome! Please verify your email address by clicking the link below:\n\n${verificationUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't create an account, you can safely ignore this email.`,
		html: `
			<h2>Welcome!</h2>
			<p>Please verify your email address by clicking the link below:</p>
			<p><a href="${verificationUrl}" style="display:inline-block;padding:10px 20px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;">Verify Email</a></p>
			<p style="color:#6b7280;font-size:14px;">This link expires in 24 hours.</p>
			<p style="color:#6b7280;font-size:14px;">If you didn't create an account, you can safely ignore this email.</p>
		`,
	});

	console.log(`[email] Verification email sent to ${to}`);
}

export async function sendInviteEmail(
	to: string,
	inviteUrl: string,
	teamName: string,
	inviterName: string,
): Promise<void> {
	const transporter = createTransport();

	await transporter.sendMail({
		from: getFromAddress(),
		to,
		subject: `You've been invited to join ${teamName}`,
		text: `${inviterName} has invited you to join ${teamName} on the chatbot platform.\n\nClick the link below to accept the invitation:\n\n${inviteUrl}\n\nThis invitation expires in 7 days.`,
		html: `
			<h2>You're invited!</h2>
			<p><strong>${inviterName}</strong> has invited you to join <strong>${teamName}</strong> on the chatbot platform.</p>
			<p><a href="${inviteUrl}" style="display:inline-block;padding:10px 20px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;">Accept Invitation</a></p>
			<p style="color:#6b7280;font-size:14px;">This invitation expires in 7 days.</p>
		`,
	});

	console.log(`[email] Invite email sent to ${to}`);
}
