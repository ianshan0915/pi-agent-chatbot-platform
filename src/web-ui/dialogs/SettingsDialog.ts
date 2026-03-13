import { i18n } from "@mariozechner/mini-lit";
import { Dialog, DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

// Base class for settings tabs
export abstract class SettingsTab extends LitElement {
	abstract getTabName(): string;

	protected createRenderRoot() {
		return this;
	}
}

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
	@property({ type: Array, attribute: false }) tabs: SettingsTab[] = [];
	@state() private isOpen = false;
	@state() private activeTabIndex = 0;

	protected createRenderRoot() {
		return this;
	}

	static async open(tabs: SettingsTab[]) {
		const dialog = new SettingsDialog();
		dialog.tabs = tabs;
		dialog.isOpen = true;
		document.body.appendChild(dialog);
	}

	private setActiveTab(index: number) {
		this.activeTabIndex = index;
	}

	private renderSidebarItem(tab: SettingsTab, index: number): TemplateResult {
		const isActive = this.activeTabIndex === index;
		return html`
			<button
				class="w-full text-left px-4 py-3 rounded-md transition-colors ${
					isActive
						? "bg-secondary text-foreground font-medium"
						: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
				}"
				@click=${() => this.setActiveTab(index)}
			>
				${tab.getTabName()}
			</button>
		`;
	}

	private renderMobileTab(tab: SettingsTab, index: number): TemplateResult {
		const isActive = this.activeTabIndex === index;
		return html`
			<button
				class="px-3 py-2 text-sm font-medium transition-colors ${
					isActive ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"
				}"
				@click=${() => this.setActiveTab(index)}
			>
				${tab.getTabName()}
			</button>
		`;
	}

	render() {
		if (this.tabs.length === 0) {
			return html``;
		}

		return Dialog({
			isOpen: this.isOpen,
			onClose: () => {
				this.isOpen = false;
				this.remove();
			},
			width: "min(1000px, 90vw)",
			height: "min(800px, 90vh)",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					className: "h-full p-6",
					children: html`
						<div class="flex flex-col h-full overflow-hidden">
							<!-- Header -->
							<div class="pb-4 flex-shrink-0">${DialogHeader({ title: i18n("Settings") })}</div>

							<!-- Mobile Tabs -->
							<div class="md:hidden flex flex-shrink-0 pb-4">
								${this.tabs.map((tab, index) => this.renderMobileTab(tab, index))}
							</div>

							<!-- Layout -->
							<div class="flex flex-1 overflow-hidden">
								<!-- Sidebar (desktop only) -->
								<div class="hidden md:block w-64 flex-shrink-0 space-y-1">
									${this.tabs.map((tab, index) => this.renderSidebarItem(tab, index))}
								</div>

								<!-- Content -->
								<div class="flex-1 overflow-y-auto md:pl-6">
									${this.tabs.map(
										(tab, index) =>
											html`<div style="display: ${this.activeTabIndex === index ? "block" : "none"}">${tab}</div>`,
									)}
								</div>
							</div>
						</div>
					`,
				})}
			`,
		});
	}
}
