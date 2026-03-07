/**
 * Team Members settings tab (admin-only).
 *
 * Lists team members, allows role changes, removal, and adding
 * existing users (by search) or creating new users.
 */

import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { SettingsTab } from "../web-ui/dialogs/SettingsDialog.js";
import { apiFetch } from "../shared/api.js";

interface TeamMember {
	id: string;
	email: string;
	display_name: string | null;
	role: string;
	created_at: string;
	last_login: string | null;
}

interface SearchResult {
	id: string;
	email: string;
	display_name: string | null;
	team_id: string;
}

interface InviteToken {
	id: string;
	token: string;
	label: string | null;
	email: string | null;
	max_uses: number;
	use_count: number;
	expires_at: string;
	created_at: string;
	created_by_email: string;
	url?: string;
}

@customElement("team-members-tab")
export class TeamMembersTab extends SettingsTab {
	/** Set by the caller before opening the dialog. */
	getToken: (() => string | null) | undefined;
	currentUserId: string = "";

	@state() private members: TeamMember[] = [];
	@state() private loading = false;
	@state() private statusMessage = "";
	@state() private statusType: "success" | "error" = "success";

	// Search existing users
	@state() private searchQuery = "";
	@state() private searchResults: SearchResult[] = [];
	@state() private searching = false;

	// Create new user form
	@state() private showCreateForm = false;
	@state() private newEmail = "";
	@state() private newPassword = "";
	@state() private newDisplayName = "";
	@state() private newRole = "member";
	@state() private submitting = false;

	// Invite management
	@state() private invites: InviteToken[] = [];
	@state() private showInviteForm = false;
	@state() private inviteEmail = "";
	@state() private inviteLabel = "";
	@state() private inviteMaxUses = "10";
	@state() private creatingInvite = false;
	@state() private copiedInviteId: string | null = null;

	private searchTimer: ReturnType<typeof setTimeout> | undefined;

	getTabName(): string {
		return "Team Members";
	}

	override connectedCallback() {
		super.connectedCallback();
		this.loadMembers();
		this.loadInvites();
	}

	private fetchApi = (url: string, options?: RequestInit) => apiFetch(url, options, this.getToken);

	private async loadMembers() {
		this.loading = true;
		try {
			const result = await this.fetchApi("/api/team-members");
			if (result.success) {
				this.members = result.data.members;
			}
		} catch (err) {
			console.error("Failed to load team members:", err);
		} finally {
			this.loading = false;
		}
	}

	private handleSearchInput(value: string) {
		this.searchQuery = value;
		clearTimeout(this.searchTimer);
		if (value.length < 2) {
			this.searchResults = [];
			return;
		}
		this.searchTimer = setTimeout(() => this.doSearch(value), 300);
	}

	private async doSearch(query: string) {
		this.searching = true;
		try {
			const result = await this.fetchApi(`/api/team-members/search?email=${encodeURIComponent(query)}`);
			if (result.success) {
				this.searchResults = result.data.users;
			}
		} catch {
			// ignore
		} finally {
			this.searching = false;
		}
	}

	private async handleAddExisting(user: SearchResult) {
		try {
			const result = await this.fetchApi("/api/team-members", {
				method: "POST",
				body: JSON.stringify({ userId: user.id }),
			});
			if (result.success) {
				this.statusMessage = `Added "${user.email}" to your team.`;
				this.statusType = "success";
				this.searchQuery = "";
				this.searchResults = [];
				await this.loadMembers();
			} else {
				this.statusMessage = result.error || "Failed to add user";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleCreate() {
		if (!this.newEmail || !this.newPassword) return;
		this.submitting = true;
		this.statusMessage = "";
		try {
			const result = await this.fetchApi("/api/team-members", {
				method: "POST",
				body: JSON.stringify({
					email: this.newEmail,
					password: this.newPassword,
					displayName: this.newDisplayName || undefined,
					role: this.newRole,
				}),
			});
			if (result.success) {
				this.statusMessage = `Created "${this.newEmail}" and added to your team.`;
				this.statusType = "success";
				this.newEmail = "";
				this.newPassword = "";
				this.newDisplayName = "";
				this.newRole = "member";
				this.showCreateForm = false;
				await this.loadMembers();
			} else {
				this.statusMessage = result.error || "Failed to create user";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		} finally {
			this.submitting = false;
		}
	}

	private async handleRoleChange(member: TeamMember, newRole: string) {
		try {
			const result = await this.fetchApi(`/api/team-members/${member.id}`, {
				method: "PATCH",
				body: JSON.stringify({ role: newRole }),
			});
			if (result.success) {
				this.statusMessage = `Role updated for "${member.email}".`;
				this.statusType = "success";
				await this.loadMembers();
			} else {
				this.statusMessage = result.error || "Failed to update role";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async handleRemove(member: TeamMember) {
		if (!confirm(`Remove "${member.email}" from the team?`)) return;
		try {
			const result = await this.fetchApi(`/api/team-members/${member.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = `Removed "${member.email}".`;
				this.statusType = "success";
				await this.loadMembers();
			} else {
				this.statusMessage = result.error || "Failed to remove member";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private async loadInvites() {
		try {
			const result = await this.fetchApi("/api/invites");
			if (result.success) {
				this.invites = result.data.invites;
			}
		} catch (err) {
			console.error("Failed to load invites:", err);
		}
	}

	private async handleCreateInvite() {
		this.creatingInvite = true;
		this.statusMessage = "";
		try {
			const result = await this.fetchApi("/api/invites", {
				method: "POST",
				body: JSON.stringify({
					email: this.inviteEmail || undefined,
					label: this.inviteLabel || undefined,
					maxUses: parseInt(this.inviteMaxUses) || 10,
				}),
			});
			if (result.success) {
				const invite = result.data.invite;
				this.statusMessage = "Invite link created!";
				this.statusType = "success";
				this.inviteEmail = "";
				this.inviteLabel = "";
				this.inviteMaxUses = "10";
				this.showInviteForm = false;
				await this.loadInvites();
				// Auto-copy the new invite URL
				if (invite.url) {
					await navigator.clipboard.writeText(invite.url);
					this.statusMessage = "Invite link created and copied to clipboard!";
				}
			} else {
				this.statusMessage = result.error || "Failed to create invite";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		} finally {
			this.creatingInvite = false;
		}
	}

	private async handleCopyInvite(invite: InviteToken) {
		const url = `${window.location.origin}/?invite=${invite.token}`;
		await navigator.clipboard.writeText(url);
		this.copiedInviteId = invite.id;
		setTimeout(() => { this.copiedInviteId = null; }, 2000);
	}

	private async handleRevokeInvite(invite: InviteToken) {
		try {
			const result = await this.fetchApi(`/api/invites/${invite.id}`, { method: "DELETE" });
			if (result.success) {
				this.statusMessage = "Invite revoked.";
				this.statusType = "success";
				await this.loadInvites();
			} else {
				this.statusMessage = result.error || "Failed to revoke invite";
				this.statusType = "error";
			}
		} catch {
			this.statusMessage = "Network error";
			this.statusType = "error";
		}
	}

	private isExpired(dateStr: string): boolean {
		return new Date(dateStr) < new Date();
	}

	private formatDate(dateStr: string | null): string {
		if (!dateStr) return "Never";
		return new Date(dateStr).toLocaleDateString(undefined, {
			year: "numeric", month: "short", day: "numeric",
		});
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				${this.statusMessage ? html`
					<div class="text-sm px-3 py-2 rounded-md ${this.statusType === "success" ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"}">
						${this.statusMessage}
					</div>
				` : ""}

				<!-- Member list -->
				${this.loading ? html`<p class="text-sm text-muted-foreground">Loading...</p>` : html`
					<div class="flex flex-col gap-2">
						${this.members.map(m => html`
							<div class="flex items-center justify-between px-3 py-2 border border-border rounded-md">
								<div class="flex flex-col min-w-0">
									<span class="text-sm font-medium truncate">${m.email}</span>
									<span class="text-xs text-muted-foreground">
										${m.display_name ? `${m.display_name} · ` : ""}Last login: ${this.formatDate(m.last_login)}
									</span>
								</div>
								<div class="flex items-center gap-2 flex-shrink-0">
									<select
										class="text-xs border border-border rounded px-2 py-1 bg-background"
										.value=${m.role}
										@change=${(e: Event) => this.handleRoleChange(m, (e.target as HTMLSelectElement).value)}
										?disabled=${m.id === this.currentUserId}
									>
										<option value="member">Member</option>
										<option value="admin">Admin</option>
									</select>
									${m.id !== this.currentUserId ? html`
										<button
											class="text-xs text-destructive border border-destructive rounded px-2 py-1 hover:bg-destructive/10 cursor-pointer"
											@click=${() => this.handleRemove(m)}
										>Remove</button>
									` : ""}
								</div>
							</div>
						`)}
					</div>
				`}

				<!-- Invite links -->
				<div class="border-t border-border pt-4">
					<div class="flex items-center justify-between mb-2">
						<p class="text-sm font-medium">Invite Links</p>
						${!this.showInviteForm ? html`
							<button
								class="text-xs bg-primary text-primary-foreground rounded px-3 py-1 cursor-pointer hover:opacity-90"
								@click=${() => { this.showInviteForm = true; }}
							>Generate Link</button>
						` : ""}
					</div>

					${this.showInviteForm ? html`
						<div class="flex flex-col gap-2 mb-3 p-3 border border-border rounded-md bg-muted/30">
							<div class="flex gap-2">
								<input type="email" class="flex-1 text-sm border border-border rounded-md px-3 py-2 bg-background" placeholder="Restrict to email (optional)" .value=${this.inviteEmail} @input=${(e: Event) => { this.inviteEmail = (e.target as HTMLInputElement).value; }} />
								<input type="text" class="flex-1 text-sm border border-border rounded-md px-3 py-2 bg-background" placeholder="Label (optional)" .value=${this.inviteLabel} @input=${(e: Event) => { this.inviteLabel = (e.target as HTMLInputElement).value; }} />
							</div>
							<div class="flex gap-2 items-center">
								<label class="text-xs text-muted-foreground">Max uses:</label>
								<input type="number" min="1" class="w-20 text-sm border border-border rounded-md px-3 py-2 bg-background" .value=${this.inviteMaxUses} @input=${(e: Event) => { this.inviteMaxUses = (e.target as HTMLInputElement).value; }} />
								<div class="flex-1"></div>
								<button
									class="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
									@click=${() => { this.showInviteForm = false; }}
								>Cancel</button>
								<button
									class="text-sm bg-primary text-primary-foreground rounded-md px-4 py-2 disabled:opacity-50 cursor-pointer"
									?disabled=${this.creatingInvite}
									@click=${this.handleCreateInvite}
								>${this.creatingInvite ? "Creating..." : "Create Invite"}</button>
							</div>
						</div>
					` : ""}

					${this.invites.length === 0 ? html`
						<p class="text-xs text-muted-foreground">No active invite links. Generate one to invite team members.</p>
					` : html`
						<div class="flex flex-col gap-2">
							${this.invites.map(inv => html`
								<div class="flex items-center justify-between px-3 py-2 border border-border rounded-md ${this.isExpired(inv.expires_at) ? "opacity-50" : ""}">
									<div class="flex flex-col min-w-0">
										<span class="text-sm font-medium truncate">
											${inv.label || (inv.email ? `For ${inv.email}` : "General invite")}
										</span>
										<span class="text-xs text-muted-foreground">
											${inv.use_count}/${inv.max_uses} used · Expires ${this.formatDate(inv.expires_at)}
											${this.isExpired(inv.expires_at) ? " (expired)" : ""}
										</span>
									</div>
									<div class="flex items-center gap-2 flex-shrink-0">
										${!this.isExpired(inv.expires_at) && inv.use_count < inv.max_uses ? html`
											<button
												class="text-xs text-primary border border-primary rounded px-2 py-1 hover:bg-primary/10 cursor-pointer"
												@click=${() => this.handleCopyInvite(inv)}
											>${this.copiedInviteId === inv.id ? "Copied!" : "Copy Link"}</button>
										` : ""}
										<button
											class="text-xs text-destructive border border-destructive rounded px-2 py-1 hover:bg-destructive/10 cursor-pointer"
											@click=${() => this.handleRevokeInvite(inv)}
										>Revoke</button>
									</div>
								</div>
							`)}
						</div>
					`}
				</div>

				<!-- Add existing user by search -->
				<div class="border-t border-border pt-4">
					<p class="text-sm font-medium mb-2">Add existing user</p>
					<input
						type="text"
						class="w-full text-sm border border-border rounded-md px-3 py-2 bg-background"
						placeholder="Search by email..."
						.value=${this.searchQuery}
						@input=${(e: Event) => this.handleSearchInput((e.target as HTMLInputElement).value)}
					/>
					${this.searching ? html`<p class="text-xs text-muted-foreground mt-1">Searching...</p>` : ""}
					${this.searchResults.length > 0 ? html`
						<div class="flex flex-col gap-1 mt-2">
							${this.searchResults.map(u => html`
								<div class="flex items-center justify-between px-3 py-2 border border-border rounded-md">
									<div class="flex flex-col min-w-0">
										<span class="text-sm truncate">${u.email}</span>
										${u.display_name ? html`<span class="text-xs text-muted-foreground">${u.display_name}</span>` : ""}
									</div>
									<button
										class="text-xs text-primary border border-primary rounded px-2 py-1 hover:bg-primary/10 cursor-pointer flex-shrink-0"
										@click=${() => this.handleAddExisting(u)}
									>Add to team</button>
								</div>
							`)}
						</div>
					` : this.searchQuery.length >= 2 && !this.searching ? html`
						<p class="text-xs text-muted-foreground mt-1">No users found outside your team.</p>
					` : ""}
				</div>

				<!-- Create new user -->
				<div class="border-t border-border pt-4">
					${!this.showCreateForm ? html`
						<button
							class="text-sm text-primary hover:underline cursor-pointer"
							@click=${() => { this.showCreateForm = true; }}
						>Or create a new user...</button>
					` : html`
						<p class="text-sm font-medium mb-2">Create new user</p>
						<div class="flex flex-col gap-2">
							<div class="flex gap-2">
								<input type="email" class="flex-1 text-sm border border-border rounded-md px-3 py-2 bg-background" placeholder="Email" .value=${this.newEmail} @input=${(e: Event) => { this.newEmail = (e.target as HTMLInputElement).value; }} />
								<input type="password" class="flex-1 text-sm border border-border rounded-md px-3 py-2 bg-background" placeholder="Password" .value=${this.newPassword} @input=${(e: Event) => { this.newPassword = (e.target as HTMLInputElement).value; }} />
							</div>
							<div class="flex gap-2 items-end">
								<input type="text" class="flex-1 text-sm border border-border rounded-md px-3 py-2 bg-background" placeholder="Display name (optional)" .value=${this.newDisplayName} @input=${(e: Event) => { this.newDisplayName = (e.target as HTMLInputElement).value; }} />
								<select class="text-sm border border-border rounded-md px-3 py-2 bg-background" .value=${this.newRole} @change=${(e: Event) => { this.newRole = (e.target as HTMLSelectElement).value; }}>
									<option value="member">Member</option>
									<option value="admin">Admin</option>
								</select>
								<button
									class="text-sm bg-primary text-primary-foreground rounded-md px-4 py-2 disabled:opacity-50 cursor-pointer"
									?disabled=${!this.newEmail || !this.newPassword || this.submitting}
									@click=${this.handleCreate}
								>${this.submitting ? "Creating..." : "Create"}</button>
							</div>
						</div>
					`}
				</div>
			</div>
		`;
	}
}
