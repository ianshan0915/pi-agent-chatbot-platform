import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AuthClient } from "./auth-client.js";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

@customElement("login-page")
export class LoginPage extends LitElement {
  @property({ attribute: false })
  authClient!: AuthClient;

  @state() private mode: "login" | "register" = "login";
  @state() private email = "";
  @state() private password = "";
  @state() private displayName = "";
  @state() private teamName = "";
  @state() private error = "";
  @state() private loading = false;

  // Signup hardening states
  @state() private verificationPending = false;
  @state() private verifiedBanner = false;
  @state() private inviteToken: string | null = null;
  @state() private inviteTeamName: string | null = null;
  @state() private registrationMode = "open";
  @state() private turnstileSiteKey: string | null = null;
  @state() private turnstileResponse: string | null = null;
  @state() private resendLoading = false;
  @state() private resendSuccess = false;

  private turnstileWidgetId: string | null = null;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100vh;
      background: var(--background, #f9fafb);
      color: var(--foreground, #111827);
      font-family: system-ui, -apple-system, sans-serif;
    }

    .card {
      width: 100%;
      max-width: 400px;
      padding: 2rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border, #e5e7eb);
      background: var(--card, #ffffff);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.5rem;
      font-weight: 600;
      text-align: center;
    }

    .subtitle {
      margin: 0 0 1.5rem;
      font-size: 0.875rem;
      color: var(--muted-foreground, #6b7280);
      text-align: center;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    label {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      font-size: 0.875rem;
      font-weight: 500;
    }

    input {
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      border: 1px solid var(--border, #e5e7eb);
      background: var(--input, #ffffff);
      color: var(--foreground, #111827);
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.15s;
    }

    input:focus {
      border-color: var(--ring, #3b82f6);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
    }

    input::placeholder {
      color: var(--muted-foreground, #9ca3af);
    }

    .error {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #dc2626;
      font-size: 0.8125rem;
      line-height: 1.4;
    }

    .success-banner {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: #16a34a;
      font-size: 0.8125rem;
      line-height: 1.4;
      margin-bottom: 1rem;
    }

    button[type="submit"] {
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      border: none;
      background: var(--primary, #111827);
      color: var(--primary-foreground, #ffffff);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }

    button[type="submit"]:hover:not(:disabled) {
      opacity: 0.9;
    }

    button[type="submit"]:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-link {
      background: none;
      border: none;
      color: var(--primary, #3b82f6);
      font-size: 0.8125rem;
      cursor: pointer;
      padding: 0;
      font-weight: 500;
    }

    .btn-link:hover { text-decoration: underline; }
    .btn-link:disabled { opacity: 0.5; cursor: not-allowed; }

    .toggle {
      margin-top: 1rem;
      text-align: center;
      font-size: 0.8125rem;
      color: var(--muted-foreground, #6b7280);
    }

    .toggle a {
      color: var(--primary, #3b82f6);
      text-decoration: none;
      cursor: pointer;
      font-weight: 500;
    }

    .toggle a:hover {
      text-decoration: underline;
    }

    .verification-screen {
      text-align: center;
    }

    .verification-screen .icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .verification-screen p {
      margin: 0.5rem 0;
      font-size: 0.875rem;
      color: var(--muted-foreground, #6b7280);
    }

    .verification-screen .email-highlight {
      font-weight: 600;
      color: var(--foreground, #111827);
    }

    .resend-row {
      margin-top: 1.5rem;
      font-size: 0.8125rem;
      color: var(--muted-foreground, #6b7280);
    }

    .invite-only-notice {
      text-align: center;
      font-size: 0.875rem;
      color: var(--muted-foreground, #6b7280);
      margin-top: 1rem;
      padding: 0.75rem;
      border-radius: 0.375rem;
      background: #f9fafb;
      border: 1px solid var(--border, #e5e7eb);
    }

    .invite-banner {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #2563eb;
      font-size: 0.8125rem;
      line-height: 1.4;
      margin-bottom: 1rem;
    }

    .turnstile-container {
      display: flex;
      justify-content: center;
      min-height: 65px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.parseUrlParams();
    this.loadRegistrationConfig();
  }

  private parseUrlParams() {
    const params = new URLSearchParams(window.location.search);

    // Check for invite token
    const invite = params.get("invite");
    if (invite) {
      this.inviteToken = invite;
      this.mode = "register";
      this.validateInvite(invite);
    }

    // Check for verified=true (after email verification redirect)
    if (params.get("verified") === "true") {
      this.verifiedBanner = true;
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("verified");
      window.history.replaceState({}, "", url.toString());
    }
  }

  private async validateInvite(token: string) {
    try {
      const res = await fetch(`/api/invites/validate?token=${encodeURIComponent(token)}`);
      const body = await res.json();
      if (body.success && body.data.valid) {
        this.inviteTeamName = body.data.teamName;
        if (body.data.restrictedEmail) {
          this.email = body.data.restrictedEmail;
        }
      } else {
        this.inviteToken = null;
        this.error = "This invitation link is invalid or has expired.";
      }
    } catch {
      // Keep invite token, try to use it on submit
    }
  }

  private async loadRegistrationConfig() {
    try {
      const config = await this.authClient.getRegistrationConfig();
      this.registrationMode = config.mode;
      this.turnstileSiteKey = config.turnstileSiteKey;
    } catch {
      // Use defaults
    }
  }

  updated(changed: Map<string, unknown>) {
    // Render Turnstile widget when switching to register mode with a site key
    if ((changed.has("mode") || changed.has("turnstileSiteKey")) &&
        this.mode === "register" && this.turnstileSiteKey && !this.verificationPending) {
      this.renderTurnstile();
    }
  }

  private renderTurnstile() {
    // Wait for Turnstile script to load and the container to exist
    requestAnimationFrame(() => {
      const container = this.renderRoot.querySelector("#turnstile-container") as HTMLElement;
      if (!container || !window.turnstile || !this.turnstileSiteKey) return;

      // Remove old widget if any
      if (this.turnstileWidgetId) {
        try { window.turnstile.remove(this.turnstileWidgetId); } catch {}
        this.turnstileWidgetId = null;
      }

      this.turnstileWidgetId = window.turnstile.render(container, {
        sitekey: this.turnstileSiteKey,
        callback: (token: string) => { this.turnstileResponse = token; },
        "error-callback": () => { this.turnstileResponse = null; },
        "expired-callback": () => { this.turnstileResponse = null; },
        theme: "light",
      });
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.turnstileWidgetId && window.turnstile) {
      try { window.turnstile.remove(this.turnstileWidgetId); } catch {}
    }
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    this.error = "";
    this.loading = true;

    try {
      if (this.mode === "login") {
        await this.authClient.login(this.email, this.password);
        this.dispatchEvent(new CustomEvent("auth-success", { bubbles: true, composed: true }));
      } else {
        // Check Turnstile
        if (this.turnstileSiteKey && !this.turnstileResponse) {
          this.error = "Please complete the CAPTCHA verification.";
          this.loading = false;
          return;
        }

        await this.authClient.register(
          this.email,
          this.password,
          this.displayName || undefined,
          this.teamName || undefined,
          this.inviteToken || undefined,
          this.turnstileResponse || undefined,
        );
        this.verificationPending = true;
      }
    } catch (err: any) {
      this.error = err.message || "An unexpected error occurred";
      // Reset Turnstile on failure
      if (this.turnstileWidgetId && window.turnstile) {
        try { window.turnstile.reset(this.turnstileWidgetId); } catch {}
        this.turnstileResponse = null;
      }
    } finally {
      this.loading = false;
    }
  }

  private async handleResend() {
    this.resendLoading = true;
    this.resendSuccess = false;
    try {
      await this.authClient.resendVerification(this.email);
      this.resendSuccess = true;
    } catch {
      // Silent fail
    } finally {
      this.resendLoading = false;
    }
  }

  private backToLogin() {
    this.verificationPending = false;
    this.mode = "login";
    this.error = "";
    this.resendSuccess = false;
  }

  private switchMode() {
    this.mode = this.mode === "login" ? "register" : "login";
    this.error = "";
    this.turnstileResponse = null;
  }

  render() {
    // Verification pending screen
    if (this.verificationPending) {
      return html`
        <div class="card verification-screen">
          <div class="icon">&#x2709;</div>
          <h1>Check your email</h1>
          <p>
            We sent a verification link to
            <span class="email-highlight">${this.email}</span>
          </p>
          <p>Click the link in the email to verify your account and sign in.</p>
          <div class="resend-row">
            Didn't receive it?
            <button class="btn-link" @click=${this.handleResend} ?disabled=${this.resendLoading}>
              ${this.resendLoading ? "Sending..." : "Resend email"}
            </button>
            ${this.resendSuccess ? html`<span style="color:#16a34a;margin-left:0.5rem;">Sent!</span>` : nothing}
          </div>
          <div class="toggle">
            <a @click=${this.backToLogin}>Back to sign in</a>
          </div>
        </div>
      `;
    }

    const isLogin = this.mode === "login";
    const showSignupToggle = isLogin
      ? (this.registrationMode !== "invite" || !!this.inviteToken)
      : true;

    return html`
      <div class="card">
        <h1>${isLogin ? "Welcome back" : "Create an account"}</h1>
        <p class="subtitle">
          ${isLogin ? "Sign in to continue" : (this.inviteTeamName ? `Join ${this.inviteTeamName}` : "Get started with your team")}
        </p>

        ${this.verifiedBanner ? html`<div class="success-banner">Email verified! You can now sign in.</div>` : nothing}
        ${!isLogin && this.inviteTeamName ? html`<div class="invite-banner">You've been invited to join <strong>${this.inviteTeamName}</strong></div>` : nothing}
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}

        <form @submit=${this.handleSubmit}>
          <label>
            Email
            <input
              type="email"
              placeholder="you@example.com"
              .value=${this.email}
              @input=${(e: InputEvent) => this.email = (e.target as HTMLInputElement).value}
              required
              autocomplete="email"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              placeholder=${isLogin ? "Enter your password" : "Choose a password"}
              .value=${this.password}
              @input=${(e: InputEvent) => this.password = (e.target as HTMLInputElement).value}
              required
              minlength="6"
              autocomplete=${isLogin ? "current-password" : "new-password"}
            />
          </label>

          ${!isLogin
            ? html`
                <label>
                  Display name
                  <input
                    type="text"
                    placeholder="Your name (optional)"
                    .value=${this.displayName}
                    @input=${(e: InputEvent) => this.displayName = (e.target as HTMLInputElement).value}
                    autocomplete="name"
                  />
                </label>

                ${!this.inviteToken ? html`
                  <label>
                    Team name
                    <input
                      type="text"
                      placeholder="Your team (optional)"
                      .value=${this.teamName}
                      @input=${(e: InputEvent) => this.teamName = (e.target as HTMLInputElement).value}
                    />
                  </label>
                ` : nothing}

                ${this.turnstileSiteKey ? html`
                  <div class="turnstile-container" id="turnstile-container"></div>
                ` : nothing}
              `
            : nothing}

          <button type="submit" ?disabled=${this.loading}>
            ${this.loading
              ? (isLogin ? "Signing in..." : "Creating account...")
              : (isLogin ? "Sign in" : "Create account")}
          </button>
        </form>

        ${showSignupToggle ? html`
          <div class="toggle">
            ${isLogin
              ? html`Don't have an account? <a @click=${this.switchMode}>Sign up</a>`
              : html`Already have an account? <a @click=${this.switchMode}>Sign in</a>`}
          </div>
        ` : nothing}

        ${isLogin && this.registrationMode === "invite" && !this.inviteToken ? html`
          <div class="invite-only-notice">
            Registration is by invitation only. Ask your team admin for an invite link.
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "login-page": LoginPage;
  }
}
