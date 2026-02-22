/**
 * Agent Profiles Management Panel.
 *
 * CRUD for agent profiles: create, edit, delete specialist agents
 * with custom system prompts, curated skills, and model preferences.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface ProfileInfo {
	id: string;
	scope: string;
	owner_id: string;
	name: string;
	description: string | null;
	icon: string | null;
	system_prompt: string;
	prompt_mode: string;
	skill_ids: string[] | null;
	model_id: string | null;
	provider: string | null;
	starter_message: string | null;
	suggested_prompts: string[] | null;
	use_count: number;
	created_at: string;
}

interface SkillInfo {
	id: string;
	name: string;
	scope: string;
	description: string;
}

interface ProfileFormData {
	name: string;
	description: string;
	icon: string;
	scope: string;
	system_prompt: string;
	prompt_mode: string;
	skill_ids: string[];
	model_id: string;
	provider: string;
	starter_message: string;
	suggested_prompts: string[];
}

const EMPTY_FORM: ProfileFormData = {
	name: "",
	description: "",
	icon: "",
	scope: "user",
	system_prompt: "",
	prompt_mode: "replace",
	skill_ids: [],
	model_id: "",
	provider: "",
	starter_message: "",
	suggested_prompts: [],
};

@customElement("agent-profiles-panel")
export class AgentProfilesPanel extends LitElement {
	static override styles = css`
		:host {
			display: block;
			min-height: 400px;
		}
		.container {
			display: flex;
			flex-direction: column;
			gap: 1rem;
			max-height: 70vh;
			overflow-y: auto;
		}
		.profile-list {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}
		.profile-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.profile-info {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			flex: 1;
			min-width: 0;
		}
		.profile-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}
		.profile-icon {
			font-size: 1.25rem;
		}
		.profile-name {
			font-weight: 600;
			font-size: 0.875rem;
		}
		.profile-desc {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.profile-meta {
			display: flex;
			gap: 0.5rem;
			align-items: center;
			font-size: 0.625rem;
		}
		.scope-badge {
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding: 0.125rem 0.375rem;
			border-radius: 0.25rem;
			background: var(--muted, #f3f4f6);
			color: var(--muted-foreground, #6b7280);
		}
		.use-count {
			color: var(--muted-foreground, #6b7280);
		}
		.actions {
			display: flex;
			gap: 0.375rem;
			align-items: center;
			margin-left: 0.75rem;
			flex-shrink: 0;
		}
		.section-label {
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--muted-foreground, #6b7280);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-top: 0.5rem;
		}
		.form-container {
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
			padding: 1rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.5rem;
			background: var(--card, #fff);
		}
		.form-row {
			display: flex;
			gap: 0.75rem;
		}
		.form-field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			flex: 1;
		}
		.form-field-sm {
			flex: 0 0 auto;
			width: 80px;
		}
		label {
			font-size: 0.75rem;
			font-weight: 500;
			color: var(--muted-foreground, #6b7280);
		}
		input, select, textarea {
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.875rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-family: inherit;
		}
		textarea {
			resize: vertical;
			min-height: 4rem;
		}
		textarea.system-prompt {
			min-height: 8rem;
			font-family: monospace;
			font-size: 0.8rem;
		}
		.skill-checkboxes {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			max-height: 8rem;
			overflow-y: auto;
			padding: 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
		}
		.skill-checkbox {
			display: flex;
			align-items: center;
			gap: 0.25rem;
			font-size: 0.8rem;
		}
		.skill-checkbox input {
			margin: 0;
			padding: 0;
		}
		button {
			padding: 0.5rem 1rem;
			border: none;
			border-radius: 0.375rem;
			font-size: 0.875rem;
			cursor: pointer;
			font-weight: 500;
		}
		.btn-primary {
			background: var(--primary, #2563eb);
			color: white;
		}
		.btn-primary:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.btn-secondary {
			background: transparent;
			color: var(--foreground, #111);
			border: 1px solid var(--border, #e5e7eb);
		}
		.btn-danger {
			background: transparent;
			color: var(--destructive, #dc2626);
			border: 1px solid var(--destructive, #dc2626);
			padding: 0.25rem 0.75rem;
			font-size: 0.75rem;
		}
		.btn-edit {
			background: transparent;
			color: var(--primary, #2563eb);
			border: 1px solid var(--primary, #2563eb);
			padding: 0.25rem 0.75rem;
			font-size: 0.75rem;
		}
		.form-actions {
			display: flex;
			gap: 0.5rem;
			justify-content: flex-end;
		}
		.status {
			font-size: 0.875rem;
			padding: 0.5rem;
			border-radius: 0.375rem;
			margin-bottom: 0.5rem;
		}
		.status-success { background: #dcfce7; color: #166534; }
		.status-error { background: #fef2f2; color: #991b1b; }
		.empty {
			text-align: center;
			padding: 2rem;
			color: var(--muted-foreground, #6b7280);
			font-size: 0.875rem;
		}
		h3 { margin: 0 0 0.5rem 0; font-size: 1rem; font-weight: 600; }
		.header-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
	`;

	@property({ type: Function })
	getToken: (() => string | null) | undefined;

	@property({ type: String })
	userRole: string = "member";

	@property({ type: Function })
	onProfilesChanged: (() => void) | undefined;

	@state() private profiles: ProfileInfo[] = [];
	@state() private availableSkills: SkillInfo[] = [];
	@state() private loading = false;
	@state() private saving = false;
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";
	@state() private editingProfile: ProfileInfo | null = null;
	@state() private showForm = false;
	@state() private form: ProfileFormData = { ...EMPTY_FORM };

	override connectedCallback() {
		super.connectedCallback();
		this.loadProfiles();
		this.loadSkills();
	}

	private async fetchApi(url: string, options: RequestInit = {}): Promise<any> {
		const token = this.getToken?.();
		const res = await fetch(url, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...options.headers,
			},
		});
		return res.json();
	}

	private async loadProfiles() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/agent-profiles");
			if (result.success) {
				this.profiles = result.data.profiles;
			}
		} catch (err) {
			console.error("Failed to load profiles:", err);
		} finally {
			this.loading = false;
		}
	}

	private async loadSkills() {
		try {
			const result = await this.fetchApi("/api/skills");
			if (result.success) {
				this.availableSkills = result.data.skills;
			}
		} catch (err) {
			console.error("Failed to load skills:", err);
		}
	}

	private openNewForm() {
		this.editingProfile = null;
		this.form = { ...EMPTY_FORM };
		this.showForm = true;
		this.statusMessage = "";
	}

	private openEditForm(profile: ProfileInfo) {
		this.editingProfile = profile;
		this.form = {
			name: profile.name,
			description: profile.description || "",
			icon: profile.icon || "",
			scope: profile.scope,
			system_prompt: profile.system_prompt,
			prompt_mode: profile.prompt_mode,
			skill_ids: profile.skill_ids || [],
			model_id: profile.model_id || "",
			provider: profile.provider || "",
			starter_message: profile.starter_message || "",
			suggested_prompts: profile.suggested_prompts || [],
		};
		this.showForm = true;
		this.statusMessage = "";
	}

	private cancelForm() {
		this.showForm = false;
		this.editingProfile = null;
		this.form = { ...EMPTY_FORM };
	}

	private async handleSave() {
		if (!this.form.name || !this.form.system_prompt) {
			this.statusMessage = "Name and system prompt are required";
			this.statusType = "error";
			return;
		}

		this.saving = true;
		this.statusMessage = "";

		try {
			const body = {
				...this.form,
				skill_ids: this.form.skill_ids.length > 0 ? this.form.skill_ids : null,
				model_id: this.form.model_id || null,
				provider: this.form.provider || null,
				description: this.form.description || null,
				icon: this.form.icon || null,
				starter_message: this.form.starter_message || null,
				suggested_prompts: this.form.suggested_prompts.length > 0 ? this.form.suggested_prompts : null,
			};

			let result;
			if (this.editingProfile) {
				result = await this.fetchApi(`/api/agent-profiles/${this.editingProfile.id}`, {
					method: "PUT",
					body: JSON.stringify(body),
				});
			} else {
				result = await this.fetchApi("/api/agent-profiles", {
					method: "POST",
					body: JSON.stringify(body),
				});
			}

			if (result.success) {
				this.statusMessage = this.editingProfile
					? `Profile "${this.form.name}" updated.`
					: `Profile "${this.form.name}" created.`;
				this.statusType = "success";
				this.showForm = false;
				this.editingProfile = null;
				this.form = { ...EMPTY_FORM };
				await this.loadProfiles();
				this.onProfilesChanged?.();
			} else {
				this.statusMessage = result.error || "Save failed";
				this.statusType = "error";
			}
		} catch (err) {
			this.statusMessage = "Network error";
			this.statusType = "error";
		} finally {
			this.saving = false;
		}
	}

	private async handleDelete(profile: ProfileInfo) {
		if (!confirm(`Delete agent profile "${profile.name}"?`)) return;

		try {
			const result = await this.fetchApi(`/api/agent-profiles/${profile.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `Profile "${profile.name}" deleted.`;
				this.statusType = "success";
				await this.loadProfiles();
				this.onProfilesChanged?.();
			} else {
				this.statusMessage = result.error || "Delete failed";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private toggleSkill(skillId: string) {
		const ids = new Set(this.form.skill_ids);
		if (ids.has(skillId)) {
			ids.delete(skillId);
		} else {
			ids.add(skillId);
		}
		this.form = { ...this.form, skill_ids: [...ids] };
	}

	private updateSuggestedPrompts(value: string) {
		// Split by newlines, filter empty lines
		const prompts = value.split("\n").map(s => s.trim()).filter(Boolean);
		this.form = { ...this.form, suggested_prompts: prompts };
	}

	private renderForm() {
		const isAdmin = this.userRole === "admin";
		const scopes = isAdmin
			? [
				{ value: "user", label: "Personal" },
				{ value: "team", label: "Team" },
				{ value: "platform", label: "Platform" },
			]
			: [{ value: "user", label: "Personal" }];

		return html`
			<div class="form-container">
				<h3>${this.editingProfile ? "Edit Profile" : "New Agent Profile"}</h3>

				<div class="form-row">
					<div class="form-field-sm">
						<label>Icon</label>
						<input
							type="text"
							placeholder="e.g. emoji"
							maxlength="4"
							.value=${this.form.icon}
							@input=${(e: Event) => { this.form = { ...this.form, icon: (e.target as HTMLInputElement).value }; }}
						/>
					</div>
					<div class="form-field">
						<label>Name *</label>
						<input
							type="text"
							placeholder="e.g. Finance Agent"
							maxlength="100"
							.value=${this.form.name}
							@input=${(e: Event) => { this.form = { ...this.form, name: (e.target as HTMLInputElement).value }; }}
						/>
					</div>
					<div class="form-field">
						<label>Scope</label>
						<select
							.value=${this.form.scope}
							@change=${(e: Event) => { this.form = { ...this.form, scope: (e.target as HTMLSelectElement).value }; }}
							?disabled=${!!this.editingProfile}
						>
							${scopes.map(s => html`<option value=${s.value}>${s.label}</option>`)}
						</select>
					</div>
				</div>

				<div class="form-field">
					<label>Description</label>
					<input
						type="text"
						placeholder="Brief description of what this agent does"
						.value=${this.form.description}
						@input=${(e: Event) => { this.form = { ...this.form, description: (e.target as HTMLInputElement).value }; }}
					/>
				</div>

				<div class="form-field">
					<label>
						System Prompt *
						<select
							style="display: inline; margin-left: 0.5rem; font-size: 0.7rem;"
							.value=${this.form.prompt_mode}
							@change=${(e: Event) => { this.form = { ...this.form, prompt_mode: (e.target as HTMLSelectElement).value }; }}
						>
							<option value="replace">Replace default prompt</option>
							<option value="append">Append to default prompt</option>
						</select>
					</label>
					<textarea
						class="system-prompt"
						placeholder="You are a specialized agent that..."
						.value=${this.form.system_prompt}
						@input=${(e: Event) => { this.form = { ...this.form, system_prompt: (e.target as HTMLTextAreaElement).value }; }}
					></textarea>
				</div>

				<div class="form-row">
					<div class="form-field">
						<label>Provider (optional)</label>
						<select
							.value=${this.form.provider}
							@change=${(e: Event) => { this.form = { ...this.form, provider: (e.target as HTMLSelectElement).value }; }}
						>
							<option value="">Default</option>
							<option value="anthropic">Anthropic</option>
							<option value="openai">OpenAI</option>
							<option value="google">Google</option>
						</select>
					</div>
					<div class="form-field">
						<label>Model (optional)</label>
						<input
							type="text"
							placeholder="e.g. claude-sonnet-4-20250514"
							.value=${this.form.model_id}
							@input=${(e: Event) => { this.form = { ...this.form, model_id: (e.target as HTMLInputElement).value }; }}
						/>
					</div>
				</div>

				${this.availableSkills.length > 0 ? html`
					<div class="form-field">
						<label>Skills (select which skills this agent can use)</label>
						<div class="skill-checkboxes">
							${this.availableSkills.map(skill => html`
								<label class="skill-checkbox">
									<input
										type="checkbox"
										.checked=${this.form.skill_ids.includes(skill.id)}
										@change=${() => this.toggleSkill(skill.id)}
									/>
									<span>${skill.name}</span>
									<span style="font-size: 0.6rem; color: var(--muted-foreground);">(${skill.scope})</span>
								</label>
							`)}
						</div>
					</div>
				` : nothing}

				<div class="form-field">
					<label>Starter Message (optional — shown when chat starts)</label>
					<textarea
						placeholder="Hi! I'm the Finance Agent. I can help you with..."
						.value=${this.form.starter_message}
						@input=${(e: Event) => { this.form = { ...this.form, starter_message: (e.target as HTMLTextAreaElement).value }; }}
					></textarea>
				</div>

				<div class="form-field">
					<label>Suggested Prompts (one per line, optional)</label>
					<textarea
						placeholder="Check Q4 revenue&#10;Run expense report&#10;Compare budgets"
						.value=${this.form.suggested_prompts.join("\n")}
						@input=${(e: Event) => this.updateSuggestedPrompts((e.target as HTMLTextAreaElement).value)}
					></textarea>
				</div>

				<div class="form-actions">
					<button class="btn-secondary" @click=${() => this.cancelForm()}>Cancel</button>
					<button
						class="btn-primary"
						?disabled=${this.saving || !this.form.name || !this.form.system_prompt}
						@click=${() => this.handleSave()}
					>
						${this.saving ? "Saving..." : (this.editingProfile ? "Update" : "Create")}
					</button>
				</div>
			</div>
		`;
	}

	override render() {
		if (this.showForm) {
			return html`
				<div class="container">
					${this.statusMessage
						? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
						: nothing}
					${this.renderForm()}
				</div>
			`;
		}

		// Group profiles by scope
		const platformProfiles = this.profiles.filter(p => p.scope === "platform");
		const teamProfiles = this.profiles.filter(p => p.scope === "team");
		const userProfiles = this.profiles.filter(p => p.scope === "user");

		return html`
			<div class="container">
				<div class="header-row">
					<h3>Agent Profiles</h3>
					<button class="btn-primary" @click=${() => this.openNewForm()}>+ New Profile</button>
				</div>

				${this.statusMessage
					? html`<div class="status ${this.statusType === "success" ? "status-success" : "status-error"}">${this.statusMessage}</div>`
					: nothing}

				${this.loading
					? html`<div class="empty">Loading...</div>`
					: this.profiles.length === 0
						? html`<div class="empty">No agent profiles yet. Create one to get started.</div>`
						: html`
							${platformProfiles.length > 0 ? html`
								<div class="section-label">Platform</div>
								<div class="profile-list">
									${platformProfiles.map(p => this.renderProfileItem(p))}
								</div>
							` : nothing}

							${teamProfiles.length > 0 ? html`
								<div class="section-label">Team</div>
								<div class="profile-list">
									${teamProfiles.map(p => this.renderProfileItem(p))}
								</div>
							` : nothing}

							${userProfiles.length > 0 ? html`
								<div class="section-label">Personal</div>
								<div class="profile-list">
									${userProfiles.map(p => this.renderProfileItem(p))}
								</div>
							` : nothing}
						`}
			</div>
		`;
	}

	private renderProfileItem(profile: ProfileInfo) {
		const isAdmin = this.userRole === "admin";
		const canEdit =
			(profile.scope === "user") ||
			((profile.scope === "platform" || profile.scope === "team") && isAdmin);

		const skillNames = profile.skill_ids
			? this.availableSkills
				.filter(s => profile.skill_ids!.includes(s.id))
				.map(s => s.name)
			: [];

		return html`
			<div class="profile-item">
				<div class="profile-info">
					<div class="profile-header">
						${profile.icon ? html`<span class="profile-icon">${profile.icon}</span>` : nothing}
						<span class="profile-name">${profile.name}</span>
						<span class="scope-badge">${profile.scope}</span>
					</div>
					${profile.description ? html`<span class="profile-desc">${profile.description}</span>` : nothing}
					<div class="profile-meta">
						${profile.model_id ? html`<span>Model: ${profile.model_id}</span>` : nothing}
						${skillNames.length > 0 ? html`<span>Skills: ${skillNames.join(", ")}</span>` : nothing}
						<span class="use-count">${profile.use_count} uses</span>
					</div>
				</div>
				${canEdit ? html`
					<div class="actions">
						<button class="btn-edit" @click=${() => this.openEditForm(profile)}>Edit</button>
						<button class="btn-danger" @click=${() => this.handleDelete(profile)}>Delete</button>
					</div>
				` : nothing}
			</div>
		`;
	}
}
