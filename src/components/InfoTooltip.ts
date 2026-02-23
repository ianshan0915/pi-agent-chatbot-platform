/**
 * Reusable CSS-only tooltip component.
 *
 * Usage: <info-tooltip text="Explanation here"></info-tooltip>
 *
 * Renders a small "?" icon that shows a tooltip on hover.
 */

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("info-tooltip")
export class InfoTooltip extends LitElement {
	static override styles = css`
		:host {
			display: inline-flex;
			align-items: center;
			position: relative;
		}
		.trigger {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			background: var(--muted, #f3f4f6);
			color: var(--muted-foreground, #6b7280);
			font-size: 0.6rem;
			font-weight: 600;
			cursor: help;
			border: 1px solid var(--border, #e5e7eb);
			line-height: 1;
			user-select: none;
		}
		.trigger:hover {
			background: var(--border, #e5e7eb);
			color: var(--foreground, #111);
		}
		.tooltip {
			display: none;
			position: absolute;
			bottom: calc(100% + 6px);
			left: 50%;
			transform: translateX(-50%);
			padding: 0.375rem 0.5rem;
			border-radius: 0.375rem;
			background: var(--foreground, #111);
			color: var(--background, #fff);
			font-size: 0.7rem;
			line-height: 1.4;
			white-space: normal;
			width: max-content;
			max-width: 220px;
			z-index: 100;
			pointer-events: none;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
		}
		.tooltip::after {
			content: "";
			position: absolute;
			top: 100%;
			left: 50%;
			transform: translateX(-50%);
			border: 4px solid transparent;
			border-top-color: var(--foreground, #111);
		}
		.trigger:hover + .tooltip {
			display: block;
		}
	`;

	@property({ type: String })
	text = "";

	override render() {
		return html`
			<span class="trigger">?</span>
			<span class="tooltip">${this.text}</span>
		`;
	}
}
