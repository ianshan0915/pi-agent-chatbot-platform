/**
 * Human-readable cron expression builder.
 *
 * Provides preset schedules (daily, weekday, weekly, hourly) with
 * time/day pickers, plus a custom cron input. Emits `cron-change`
 * events with the resulting cron expression.
 */

import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

type Preset = "daily" | "weekday" | "weekly" | "hourly" | "custom";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function describeCron(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return cron;

	const [min, hour, , , dow] = parts;

	const timeStr = (h: string, m: string) => {
		const hNum = parseInt(h, 10);
		const mNum = parseInt(m, 10);
		const ampm = hNum >= 12 ? "PM" : "AM";
		const h12 = hNum === 0 ? 12 : hNum > 12 ? hNum - 12 : hNum;
		return `${h12}:${mNum.toString().padStart(2, "0")} ${ampm}`;
	};

	// Every hour
	if (hour === "*" && dow === "*") {
		return `Runs: Every hour at :${min.padStart(2, "0")}`;
	}

	// Weekday at specific time
	if (dow === "1-5") {
		return `Runs: Every weekday at ${timeStr(hour, min)}`;
	}

	// Weekly on specific day
	if (dow !== "*" && !dow.includes(",") && !dow.includes("-")) {
		const dayName = DAY_LABELS[parseInt(dow, 10)] || dow;
		return `Runs: Every ${dayName} at ${timeStr(hour, min)}`;
	}

	// Daily at specific time
	if (dow === "*" && hour !== "*") {
		return `Runs: Every day at ${timeStr(hour, min)}`;
	}

	return `Runs: ${cron}`;
}

@customElement("cron-builder")
export class CronBuilder extends LitElement {
	static override styles = css`
		:host {
			display: block;
		}
		.builder {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}
		.preset-row {
			display: flex;
			flex-wrap: wrap;
			gap: 0.25rem;
		}
		.preset-btn {
			padding: 0.25rem 0.625rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.8rem;
			cursor: pointer;
			background: transparent;
			color: var(--foreground, #111);
			font-family: inherit;
		}
		.preset-btn:hover {
			background: var(--muted, #f3f4f6);
		}
		.preset-btn.active {
			background: var(--primary, #2563eb);
			color: white;
			border-color: var(--primary, #2563eb);
		}
		.config-row {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: wrap;
		}
		.config-row label {
			font-size: 0.8rem;
			color: var(--muted-foreground, #6b7280);
		}
		select, input {
			padding: 0.375rem 0.5rem;
			border: 1px solid var(--border, #e5e7eb);
			border-radius: 0.375rem;
			font-size: 0.8rem;
			background: var(--background, #fff);
			color: var(--foreground, #111);
			font-family: inherit;
		}
		input:focus, select:focus {
			outline: none;
			border-color: var(--primary, #2563eb);
		}
		.custom-input {
			width: 100%;
		}
		.preview {
			font-size: 0.75rem;
			color: var(--muted-foreground, #6b7280);
			font-style: italic;
			padding: 0.25rem 0;
		}
	`;

	@property({ type: String })
	value = "0 9 * * *";

	@state() private preset: Preset = "daily";
	@state() private hour = "9";
	@state() private minute = "0";
	@state() private dayOfWeek = "1"; // Monday
	@state() private customCron = "";

	override connectedCallback() {
		super.connectedCallback();
		this._parseInitialValue();
	}

	private _parseInitialValue() {
		const parts = this.value.trim().split(/\s+/);
		if (parts.length !== 5) {
			this.preset = "custom";
			this.customCron = this.value;
			return;
		}

		const [min, hour, , , dow] = parts;

		if (hour === "*") {
			this.preset = "hourly";
			this.minute = min;
		} else if (dow === "1-5") {
			this.preset = "weekday";
			this.hour = hour;
			this.minute = min;
		} else if (dow !== "*") {
			this.preset = "weekly";
			this.hour = hour;
			this.minute = min;
			this.dayOfWeek = dow;
		} else {
			this.preset = "daily";
			this.hour = hour;
			this.minute = min;
		}
	}

	private _buildCron(): string {
		switch (this.preset) {
			case "daily":
				return `${this.minute} ${this.hour} * * *`;
			case "weekday":
				return `${this.minute} ${this.hour} * * 1-5`;
			case "weekly":
				return `${this.minute} ${this.hour} * * ${this.dayOfWeek}`;
			case "hourly":
				return `${this.minute} * * * *`;
			case "custom":
				return this.customCron || "0 9 * * *";
		}
	}

	private _emit() {
		const cron = this._buildCron();
		this.dispatchEvent(new CustomEvent("cron-change", {
			detail: { value: cron },
			bubbles: true,
			composed: true,
		}));
	}

	private _setPreset(p: Preset) {
		this.preset = p;
		if (p === "custom") {
			this.customCron = this._buildCron();
		}
		this._emit();
	}

	private _renderTimePicker() {
		if (this.preset === "custom" || this.preset === "hourly") return "";

		const hours = Array.from({ length: 24 }, (_, i) => i);
		const minutes = [0, 15, 30, 45];

		return html`
			<div class="config-row">
				<label>at</label>
				<select .value=${this.hour} @change=${(e: Event) => { this.hour = (e.target as HTMLSelectElement).value; this._emit(); }}>
					${hours.map(h => html`<option value=${h.toString()}>${h.toString().padStart(2, "0")}</option>`)}
				</select>
				<label>:</label>
				<select .value=${this.minute} @change=${(e: Event) => { this.minute = (e.target as HTMLSelectElement).value; this._emit(); }}>
					${minutes.map(m => html`<option value=${m.toString()}>${m.toString().padStart(2, "0")}</option>`)}
				</select>
			</div>
		`;
	}

	private _renderDayPicker() {
		if (this.preset !== "weekly") return "";

		return html`
			<div class="config-row">
				<label>on</label>
				<select .value=${this.dayOfWeek} @change=${(e: Event) => { this.dayOfWeek = (e.target as HTMLSelectElement).value; this._emit(); }}>
					${DAY_LABELS.map((label, i) => html`<option value=${i.toString()}>${label}</option>`)}
				</select>
			</div>
		`;
	}

	private _renderHourlyMinute() {
		if (this.preset !== "hourly") return "";

		const minutes = Array.from({ length: 60 }, (_, i) => i);
		return html`
			<div class="config-row">
				<label>at minute</label>
				<select .value=${this.minute} @change=${(e: Event) => { this.minute = (e.target as HTMLSelectElement).value; this._emit(); }}>
					${minutes.map(m => html`<option value=${m.toString()}>${m.toString().padStart(2, "0")}</option>`)}
				</select>
			</div>
		`;
	}

	override render() {
		const cron = this._buildCron();

		return html`
			<div class="builder">
				<div class="preset-row">
					${(["daily", "weekday", "weekly", "hourly", "custom"] as Preset[]).map(p => html`
						<button
							class="preset-btn ${this.preset === p ? "active" : ""}"
							@click=${() => this._setPreset(p)}
						>
							${{ daily: "Every day", weekday: "Weekdays", weekly: "Weekly", hourly: "Every hour", custom: "Custom" }[p]}
						</button>
					`)}
				</div>

				${this._renderDayPicker()}
				${this._renderTimePicker()}
				${this._renderHourlyMinute()}

				${this.preset === "custom" ? html`
					<input
						class="custom-input"
						type="text"
						placeholder="0 9 * * *"
						.value=${this.customCron}
						@input=${(e: Event) => { this.customCron = (e.target as HTMLInputElement).value; this._emit(); }}
					/>
				` : ""}

				<div class="preview">${describeCron(cron)}</div>
			</div>
		`;
	}
}
