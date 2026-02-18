import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import JSZip from "jszip";
import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { i18n } from "../../utils/i18n.js";
import { ArtifactElement } from "./ArtifactElement.js";

interface SlideData {
	index: number;
	texts: string[];
	imageBlobs: string[]; // data URLs for embedded images
}

@customElement("pptx-artifact")
export class PptxArtifact extends ArtifactElement {
	@property({ type: String }) private _content = "";
	@state() private error: string | null = null;
	@state() private slides: SlideData[] = [];
	@state() private currentSlide = 0;

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		this._content = value;
		this.error = null;
		this.currentSlide = 0;
		this.parsePptx();
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.style.height = "100%";
	}

	private decodeBase64(): Uint8Array {
		let base64Data = this._content;
		if (this._content.startsWith("data:")) {
			const base64Match = this._content.match(/base64,(.+)/);
			if (base64Match) {
				base64Data = base64Match[1];
			}
		}

		const binaryString = atob(base64Data);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	public getHeaderButtons() {
		return html`
			<div class="flex items-center gap-1">
				${DownloadButton({
					content: this.decodeBase64(),
					filename: this.filename,
					mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
					title: i18n("Download"),
				})}
			</div>
		`;
	}

	private async parsePptx() {
		if (!this._content) return;

		try {
			const bytes = this.decodeBase64();
			const zip = await JSZip.loadAsync(bytes);

			// Find all slide XML files
			const slideFiles: string[] = [];
			zip.forEach((relativePath) => {
				const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
				if (match) {
					slideFiles.push(relativePath);
				}
			});

			// Sort by slide number
			slideFiles.sort((a, b) => {
				const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0");
				const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0");
				return numA - numB;
			});

			// Build a map of relationship targets for images
			const imageMap = new Map<string, string>(); // rId -> data URL

			// Parse each slide
			const parsedSlides: SlideData[] = [];
			for (let i = 0; i < slideFiles.length; i++) {
				const slideFile = slideFiles[i];
				const slideXml = await zip.file(slideFile)?.async("text");
				if (!slideXml) continue;

				// Extract text from <a:t> tags
				const texts: string[] = [];
				const textMatches = slideXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g);
				let currentParagraph = "";
				let lastMatchEnd = 0;

				// Check for paragraph breaks between text runs
				const paragraphBreaks = [...slideXml.matchAll(/<\/a:p>/g)].map((m) => m.index!);
				let paragraphBreakIdx = 0;

				for (const match of textMatches) {
					// Check if there was a paragraph break since the last text
					while (paragraphBreakIdx < paragraphBreaks.length && paragraphBreaks[paragraphBreakIdx] < match.index!) {
						if (currentParagraph.trim()) {
							texts.push(currentParagraph.trim());
						}
						currentParagraph = "";
						paragraphBreakIdx++;
					}
					currentParagraph += match[1];
					lastMatchEnd = match.index! + match[0].length;
				}
				if (currentParagraph.trim()) {
					texts.push(currentParagraph.trim());
				}

				// Try to load embedded images from slide relationships
				const imageBlobs: string[] = [];
				const slideNum = slideFile.match(/slide(\d+)/)?.[1];
				const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
				const relsXml = await zip.file(relsPath)?.async("text");

				if (relsXml) {
					const relMatches = relsXml.matchAll(/Target="([^"]*\.(png|jpg|jpeg|gif|bmp|webp))"/gi);
					for (const relMatch of relMatches) {
						let imagePath = relMatch[1];
						// Resolve relative paths
						if (imagePath.startsWith("../")) {
							imagePath = "ppt/" + imagePath.replace("../", "");
						} else if (!imagePath.startsWith("ppt/")) {
							imagePath = "ppt/slides/" + imagePath;
						}

						const imageFile = zip.file(imagePath);
						if (imageFile) {
							const imageData = await imageFile.async("base64");
							const ext = relMatch[2].toLowerCase();
							const mimeType =
								ext === "jpg" || ext === "jpeg"
									? "image/jpeg"
									: ext === "png"
										? "image/png"
										: ext === "gif"
											? "image/gif"
											: ext === "webp"
												? "image/webp"
												: ext === "bmp"
													? "image/bmp"
													: "image/png";
							imageBlobs.push(`data:${mimeType};base64,${imageData}`);
						}
					}
				}

				parsedSlides.push({
					index: i,
					texts,
					imageBlobs,
				});
			}

			this.slides = parsedSlides;
			if (this.slides.length === 0) {
				this.error = "No slides found in the presentation";
			}
		} catch (err: any) {
			console.error("Error parsing PPTX:", err);
			this.error = err?.message || "Failed to parse PowerPoint file";
		}
	}

	private goToSlide(index: number) {
		if (index >= 0 && index < this.slides.length) {
			this.currentSlide = index;
		}
	}

	override render(): TemplateResult {
		if (this.error) {
			return html`
				<div class="h-full flex items-center justify-center bg-background p-4">
					<div class="bg-destructive/10 border border-destructive text-destructive p-4 rounded-lg max-w-2xl">
						<div class="font-medium mb-1">${i18n("Error loading document")}</div>
						<div class="text-sm opacity-90">${this.error}</div>
					</div>
				</div>
			`;
		}

		if (this.slides.length === 0) {
			return html`
				<div class="h-full flex items-center justify-center bg-background">
					<div class="text-muted-foreground text-sm">Loading presentation...</div>
				</div>
			`;
		}

		const slide = this.slides[this.currentSlide];

		return html`
			<div class="h-full flex flex-col bg-background overflow-hidden">
				<!-- Slide content -->
				<div class="flex-1 overflow-auto flex items-center justify-center p-4">
					<div
						class="w-full bg-white text-black rounded-lg shadow-lg overflow-hidden"
						style="max-width: 960px; aspect-ratio: 16/9;"
					>
						<div class="w-full h-full flex flex-col justify-center p-8 overflow-auto">
							<!-- Images -->
							${slide.imageBlobs.length > 0
								? html`
										<div class="flex flex-wrap gap-2 justify-center mb-4">
											${slide.imageBlobs.map(
												(src) => html` <img src="${src}" class="max-h-48 max-w-full object-contain rounded" /> `,
											)}
										</div>
									`
								: ""}
							<!-- Text content -->
							${slide.texts.map((text, idx) => {
								// First text is usually the title
								if (idx === 0 && slide.texts.length > 1) {
									return html`<div class="text-2xl font-bold mb-4 text-center">${text}</div>`;
								}
								return html`<div class="text-base mb-2 ${idx === 0 ? "text-xl font-semibold text-center" : ""}">${text}</div>`;
							})}
							${slide.texts.length === 0 && slide.imageBlobs.length === 0
								? html`<div class="text-gray-400 text-center italic">Empty slide</div>`
								: ""}
						</div>
					</div>
				</div>

				<!-- Navigation -->
				${this.slides.length > 1
					? html`
							<div class="flex items-center justify-center gap-3 py-3 border-t border-border bg-background">
								<button
									class="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
									?disabled=${this.currentSlide === 0}
									@click=${() => this.goToSlide(this.currentSlide - 1)}
								>
									Prev
								</button>
								<span class="text-sm text-muted-foreground">
									Slide ${this.currentSlide + 1} of ${this.slides.length}
								</span>
								<button
									class="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
									?disabled=${this.currentSlide === this.slides.length - 1}
									@click=${() => this.goToSlide(this.currentSlide + 1)}
								>
									Next
								</button>
							</div>
						`
					: ""}
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"pptx-artifact": PptxArtifact;
	}
}
