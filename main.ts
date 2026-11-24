import {
	App,
	ButtonComponent,
	Editor,
	MarkdownView,
	Menu,
	MenuItem,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	debounce,
	requestUrl,
	setIcon,
} from "obsidian";

type TitleSource = "markdown" | "website";
type CardLayout = "horizontal" | "vertical";
type CardBackground = "transparent" | "padded" | "edge" | "overlay";
type ScreenshotTheme = "light" | "dark";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const MAX_HTML = 400_000;

const HIDE_SCROLLBAR_CSS = `
	* { scrollbar-width: none !important; }
	*::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
`;

const COOKIE_BANNER_CSS = [
	"#onetrust-consent-sdk", "#onetrust-banner-sdk", ".onetrust-pc-dark-filter", "#CybotCookiebotDialog",
	"#CybotCookiebotDialogBodyUnderlay", "#didomi-host", ".didomi-popup-backdrop", "#didomi-notice",
	"#qc-cmp2-container", ".qc-cmp2-container", "#usercentrics-root", "#cookie-law-info-bar", ".cc-window",
	".cc-banner", "#cookie-notice", "#cookie-banner", ".cookie-banner", ".cookie-consent", "#cookieconsent",
	".fc-consent-root", "[id^='sp_message_container']", ".sp_veil", "iframe[id^='sp_message_iframe']",
	"#gdpr-cookie-message", ".osano-cm-window", "#iubenda-cs-banner", ".iubenda-cs-container",
	"#cmp-app-container", "#cookiescript_injected", ".klaro", "#hs-eu-cookie-confirmation", ".truste_box_overlay",
	"[id*='cookie-banner' i]", "[class*='cookie-banner' i]", "[id*='cookiebanner' i]", "[class*='cookiebanner' i]",
	"[id*='cookie-consent' i]", "[class*='cookie-consent' i]", "[class*='cookieconsent' i]",
	"[id*='consent-banner' i]", "[class*='consent-banner' i]",
	"[role='dialog'][aria-label*='cookie' i]", "[role='dialog'][aria-label*='consent' i]",
	".cky-consent-container", ".cky-overlay", ".cmplz-cookiebanner", "#moove_gdpr_cookie_info_bar", "#cookiefirst-root",
	"#truste-consent-track", "#CookieConsent", "#termly-code-snippet-support",
	"iframe[src*='privacy-mgmt.com']", "iframe[src*='consentmanager.net']", "iframe[src*='cookiebot.com']",
	"iframe[src*='onetrust.com']", "iframe[src*='didomi.io']", "iframe[src*='trustarc.com']", "iframe[src*='consent.']",
].join(",\n") + " { display: none !important; }\nhtml, body { overflow: auto !important; }";

const COOKIE_BANNER_SCRIPT = `(() => {
	if (window.__wlgCmp) { window.__wlgCmp(); return; }
	const words = /cookie|consent|gdpr|rodo|ciasteczk|datenschutz|privacy|privacidad|confidentialit|zgod|prywatno|tracking|vendors/i;
	const buttons = /accept|agree|allow|reject|decline|deny|manage|preferences|got it|akcept|zgadzam|zgoda|odrzu|akzeptieren|zustimmen|ablehnen|accepter|refuser|aceptar|rechazar|accetta|rifiuta|aceitar|rejeitar/i;
	let found = 0;
	let sweeps = 0;
	const each = (root, fn) => {
		for (const el of root.querySelectorAll("*")) {
			fn(el);
			if (el.shadowRoot) each(el.shadowRoot, fn);
		}
	};
	const deepText = (el) => {
		let text = el.innerText || "";
		if (el.shadowRoot) text += " " + el.shadowRoot.textContent;
		for (const d of el.querySelectorAll("*")) if (d.shadowRoot) text += " " + d.shadowRoot.textContent;
		return text;
	};
	const hide = (el) => { el.style.setProperty("display", "none", "important"); found++; };
	const sweep = () => {
		sweeps++;
		each(document, (el) => {
			if (el.style.display === "none") return;
			const pos = getComputedStyle(el).position;
			if (pos !== "fixed" && pos !== "sticky") return;
			if (el.matches("header, nav, main") || el.querySelector("main, article")) return;
			const box = el.getBoundingClientRect();
			if (box.width < 200 || box.height < 40) return;
			const text = deepText(el);
			if (text.length > 3000 || !words.test(text) || !buttons.test(text)) return;
			hide(el);
		});
		if (found > 0) {
			each(document, (el) => {
				if (el.style.display === "none") return;
				const cs = getComputedStyle(el);
				if (cs.position !== "fixed") return;
				const box = el.getBoundingClientRect();
				if (box.width < innerWidth * 0.95 || box.height < innerHeight * 0.95) return;
				if ((el.innerText || "").trim() || el.querySelector("video, canvas, iframe, img")) return;
				if (/^rgba/.test(cs.backgroundColor) || cs.backdropFilter !== "none") hide(el);
			});
		}
		for (const el of [document.documentElement, document.body]) {
			if (el) el.style.setProperty("overflow", "auto", "important");
		}
	};
	let timer = 0;
	const schedule = () => {
		if (timer || sweeps >= 20) return;
		timer = setTimeout(() => { timer = 0; sweep(); }, 300);
	};
	const observer = new MutationObserver(schedule);
	observer.observe(document.documentElement, { childList: true, subtree: true });
	setTimeout(() => observer.disconnect(), 12000);
	window.__wlgCmp = sweep;
	sweep();
})();`;

async function emulateTheme(view: { getWebContentsId(): number }, theme: ScreenshotTheme): Promise<() => void> {
	type Debugger = { attach(version: string): void; detach(): void; sendCommand(method: string, params?: object): Promise<unknown> };
	type Remote = { webContents?: { fromId(id: number): { debugger: Debugger } | undefined } };
	try {
		const load = (window as unknown as { require?: (id: string) => unknown }).require;
		if (!load) return () => undefined;
		let remote: Remote | undefined;
		try {
			remote = (load("electron") as { remote?: Remote }).remote;
		} catch {
			// Ignored on purpose: this step is best effort.
		}
		if (!remote?.webContents) remote = load("@electron/remote") as Remote;
		const dbg = remote.webContents?.fromId(view.getWebContentsId())?.debugger;
		if (!dbg) return () => undefined;
		dbg.attach("1.3");
		await dbg.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		return () => {
			try {
				dbg.detach();
			} catch {
				// Ignored on purpose: this step is best effort.
			}
		};
	} catch {
		return () => undefined;
	}
}

const SCREENSHOT_JPEG_QUALITY = 85;

type NativeImg = {
	isEmpty(): boolean;
	getSize(): { width: number; height: number };
	resize(options: { width: number; quality?: string }): NativeImg;
	toJPEG(quality: number): Uint8Array;
};

interface SiteInfo {
	at: number;
	title: string;
	description: string;
	image: string;
	icon: string;
	v: number;
}

interface WebsiteGallerySettings {
	enabled: boolean;
	excludedDomains: string[];
	exclusionsCleaned: boolean;
	layout: CardLayout;
	cardBackground: CardBackground;
	columns: number;
	marginTop: number;
	marginBottom: number;
	gapHorizontal: number;
	gapVertical: number;
	titleSize: number;
	titleLines: number;
	hoverCard: boolean;
	hoverZoom: boolean;
	openInWindow: boolean;
	showFullAddress: boolean;
	playerWidth: number;
	screenshotWidth: number;
	screenshotTheme: ScreenshotTheme;
	screenshotSaveWidth: number;
	screenshotSizeReset: boolean;
	hideCookieBanners: boolean;
	screenshots: Record<string, string>;
	titleSource: TitleSource;
	showDescription: boolean;
	showDomain: boolean;
	showFavicon: boolean;
	titleOnPaste: boolean;
	preloadImages: boolean;
	faviconSize: number;
	customNoteWidth: boolean;
	noteWidth: number;
	cache: Record<string, SiteInfo>;
}

const DEFAULT_EXCLUDED = ["youtube.com", "youtu.be"];

const DEFAULT_SETTINGS: WebsiteGallerySettings = {
	enabled: true,
	excludedDomains: [...DEFAULT_EXCLUDED],
	exclusionsCleaned: false,
	layout: "horizontal",
	cardBackground: "edge",
	columns: 1,
	marginTop: 16,
	marginBottom: 30,
	gapHorizontal: 12,
	gapVertical: 12,
	titleSize: 14,
	titleLines: 2,
	hoverCard: true,
	hoverZoom: true,
	openInWindow: true,
	showFullAddress: false,
	playerWidth: 720,
	screenshotWidth: 1024,
	screenshotTheme: "light",
	screenshotSaveWidth: 1024,
	screenshotSizeReset: true,
	hideCookieBanners: true,
	screenshots: {},
	titleSource: "markdown",
	showDescription: true,
	showDomain: true,
	showFavicon: true,
	titleOnPaste: false,
	preloadImages: true,
	faviconSize: 16,
	customNoteWidth: false,
	noteWidth: 1000,
	cache: {},
};

function normalizeDomain(raw: string): string {
	let domain = raw.trim().toLowerCase();
	domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	domain = (domain.split(/[/?#]/)[0] ?? "").replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
	return /^[^\s.]+(\.[^\s.]+)+$/.test(domain) ? domain : "";
}

function parseDomains(text: string): string[] {
	const out: string[] = [];
	for (const part of text.split(/[\s,;]+/)) {
		const domain = normalizeDomain(part);
		if (domain && !out.includes(domain)) out.push(domain);
	}
	return out;
}

function titleWithCheck(app: App, item: MenuItem, title: string, active: boolean): MenuItem {
	item.setTitle(title);
	if (!active) return item;
	const nativeMenus = (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.("nativeMenus") === true;
	const parts = item as MenuItem & { titleEl?: HTMLElement; dom?: HTMLElement };
	const host = nativeMenus ? null : (parts.titleEl ?? parts.dom?.querySelector<HTMLElement>(".menu-item-title"));
	if (host) setIcon(host.createSpan({ cls: "wlg-menu-check" }), "check");
	else item.setTitle(`${title}  \u2714`);
	return item;
}

const LOW_IMAGE_WIDTH = 400;

const PRELOAD_MARGIN = 800;

function scrollParent(el: HTMLElement): Element | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow === "auto" || overflow === "scroll") return node;
	}
	return null;
}

function safeUrl(href: string): URL | null {
	try {
		const url = new URL(href);
		return url.protocol === "https:" || url.protocol === "http:" ? url : null;
	} catch {
		return null;
	}
}

function safeFromCodePoint(code: number): string {
	try {
		return String.fromCodePoint(code);
	} catch {
		return "";
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

function parseAttributes(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(tag))) {
		out[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
	}
	return out;
}

function resolveUrl(value: string | undefined, base: string): string {
	if (!value) return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed, base);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
	} catch {
		return "";
	}
}

function headerValue(headers: Record<string, string>, name: string): string {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === wanted) return value;
	}
	return "";
}

function largestIconSize(sizes: string | undefined): number {
	if (!sizes) return 0;
	let best = 0;
	for (const part of sizes.split(/\s+/)) {
		const match = /^(\d+)x\d+$/i.exec(part);
		if (match) best = Math.max(best, Number(match[1]));
	}
	return best;
}

function parseSite(html: string, pageUrl: string): Omit<SiteInfo, "at" | "v"> {
	const head = html.slice(0, MAX_HTML);
	const meta: Record<string, string> = {};
	for (const tag of head.match(/<meta\s[^>]*>/gi) ?? []) {
		const attrs = parseAttributes(tag);
		const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
		if (key && attrs.content && !(key in meta)) meta[key] = attrs.content;
	}

	let imageLink = "";
	let appleIcon = "";
	let bestIcon = "";
	let bestIconSize = -1;
	for (const tag of head.match(/<link\s[^>]*>/gi) ?? []) {
		const attrs = parseAttributes(tag);
		const rels = (attrs.rel ?? "").toLowerCase().split(/\s+/);
		const href = attrs.href;
		if (!href) continue;
		if (rels.includes("image_src") && !imageLink) imageLink = href;
		else if (rels.includes("apple-touch-icon") || rels.includes("apple-touch-icon-precomposed")) {
			if (!appleIcon) appleIcon = href;
		} else if (rels.includes("icon")) {
			const size = largestIconSize(attrs.sizes);
			if (size > bestIconSize) {
				bestIconSize = size;
				bestIcon = href;
			}
		}
	}

	const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
	const title = meta["og:title"] ?? meta["twitter:title"] ?? (titleTag ? decodeEntities(titleTag) : "");
	const description = meta["og:description"] ?? meta["twitter:description"] ?? meta["description"] ?? "";
	const image =
		resolveUrl(meta["og:image:secure_url"], pageUrl) ||
		resolveUrl(meta["og:image"], pageUrl) ||
		resolveUrl(meta["twitter:image"], pageUrl) ||
		resolveUrl(meta["twitter:image:src"], pageUrl) ||
		resolveUrl(imageLink, pageUrl);
	const icon = resolveUrl(appleIcon, pageUrl) || resolveUrl(bestIcon, pageUrl);

	return {
		title: title.replace(/\s+/g, " ").trim(),
		description: description.replace(/\s+/g, " ").trim(),
		image,
		icon,
	};
}

function hostLabel(url: URL): string {
	return url.hostname.replace(/^www\./i, "");
}

function removeLinkLine(data: string, href: string): string | null {
	const target = safeUrl(href)?.href;
	if (!target) return null;
	const lines = data.split("\n");
	const bare = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/;
	const link = /^(?:\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)|<([^>]+)>|(\S+))$/;
	for (let i = 0; i < lines.length; i++) {
		const rest = lines[i].replace(/\r$/, "").replace(bare, "").trim();
		const match = link.exec(rest);
		const found = match ? (match[1] ?? match[2] ?? match[3] ?? match[4]) : undefined;
		if (found && safeUrl(found)?.href === target) {
			lines.splice(i, 1);
			return lines.join("\n");
		}
	}
	return null;
}

function standaloneLinks(data: string): string[] {
	const found: string[] = [];
	const bare = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/;
	const link = /^(?:\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)|<([^>]+)>|(\S+))$/;
	let fenced = false;
	for (const raw of data.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const match = link.exec(line.replace(bare, "").trim());
		const href = match ? (match[1] ?? match[2] ?? match[3] ?? match[4]) : undefined;
		const url = href ? safeUrl(href) : null;
		if (url) found.push(url.href);
	}
	return found;
}

function hashString(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function addressLabel(url: URL, full: boolean): string {
	const host = hostLabel(url);
	if (!full) return host;
	let rest = url.pathname + url.search + url.hash;
	if (rest === "/") rest = "";
	try {
		rest = decodeURI(rest);
	} catch {
		// Ignored on purpose: this step is best effort.
	}
	return host + rest;
}

const BARE_LINE = /^(\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[.\]\s+)?)(https?:\/\/[^\s<>]+)\s*$/;

function mapBodyLines(text: string, edit: (line: string) => string | null): string {
	const lines = text.split("\n");
	let inFrontMatter = lines[0]?.trim() === "---";
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (inFrontMatter) {
			if (i > 0 && (trimmed === "---" || trimmed === "...")) inFrontMatter = false;
			continue;
		}
		const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
		if (fence) {
			if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = null;
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			continue;
		}

		const out = edit(line);
		if (out !== null) lines[i] = out;
	}
	return lines.join("\n");
}

function mapBareLines(
	text: string,
	accept: (url: string) => boolean,
	visit: (url: string) => string | null,
): string {
	return mapBodyLines(text, (line) => {
		const match = BARE_LINE.exec(line);
		if (!match || !accept(match[2])) return null;
		const link = visit(match[2]);
		return link ? match[1] + link + (line.endsWith("\r") ? "\r" : "") : null;
	});
}

function markdownLink(title: string, url: string): string {
	const label = title.replace(/\s+/g, " ").trim().replace(/([[\]])/g, "\\$1");
	const target = url.replace(/\(/g, "%28").replace(/\)/g, "%29");
	return `[${label}](${target})`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface BareScan {
	files: TFile[];
	links: number;
	urls: Set<string>;
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly paragraphs: string[],
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.heading);
		for (const text of this.paragraphs) contentEl.createEl("p", { text });
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.confirmText)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class WebsiteGalleryPlugin extends Plugin {
	settings: WebsiteGallerySettings = { ...DEFAULT_SETTINGS, cache: {}, screenshots: {} };

	private pending = new Map<string, Promise<SiteInfo | null>>();
	private failed = new Set<string>();
	private shooting = new Set<string>();
	private batchRunning = false;
	private renderSource = "";
	private shotVersion = new Map<string, number>();
	private cardRebuilders = new Map<string, Set<{ card: HTMLElement; rebuild: () => void }>>();
	private persistSoon = debounce(() => void this.saveSettings(), 2000, true);
	private backTarget: { canGoBack(): boolean; goBack(): void; capturePage(): Promise<NativeImg> } | null = null;
	private player: {
		el: HTMLElement;
		frame: HTMLElement;
		label: HTMLElement;
		backButton: HTMLElement;
		previousButton: HTMLElement;
		nextButton: HTMLElement;
		href: string;
		queue: string[];
		index: number;
		onResize: () => void;
	} | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refresh(false);

		this.addSettingTab(new WebsiteGallerySettingTab(this.app, this));
		this.registerMarkdownPostProcessor((el, ctx) => {
			this.renderSource = ctx.sourcePath;
			this.processSection(el);
		});
		this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor) => this.handlePaste(evt, editor)));

		this.app.workspace.onLayoutReady(() => this.refresh(true));
	}

	onunload(): void {
		this.persistSoon.run();
		this.closePlayer();
		for (const observer of this.observers) observer.disconnect();
		this.observers.clear();
		document.body.classList.remove(
			"wlg-horizontal",
			"wlg-vertical",
			"wlg-plain",
			"wlg-padded",
			"wlg-overlay",
			"wlg-hovercard",
			"wlg-zoom",
			"wlg-no-description",
			"wlg-no-domain",
			"wlg-no-favicon",
		);
		for (const name of [
			"--wlg-columns",
			"--wlg-mt",
			"--wlg-mb",
			"--wlg-hgap",
			"--wlg-vgap",
			"--wlg-title-size",
			"--wlg-title-lines",
			"--wlg-favicon-size",
			"--wlg-player-width",
			"--file-line-width",
		]) {
			document.body.style.removeProperty(name);
		}
		document.querySelectorAll(".wlg-gallery").forEach((el) => el.remove());
		document.querySelectorAll(".wlg-source").forEach((el) => el.classList.remove("wlg-source"));
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<WebsiteGallerySettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			cache: { ...(data?.cache ?? {}) },
			screenshots: { ...(data?.screenshots ?? {}) },
		};
		const s = this.settings;

		const legacySkipYouTube = (data as { skipYouTube?: boolean } | null)?.skipYouTube;
		if (Array.isArray(data?.excludedDomains)) s.excludedDomains = parseDomains(data.excludedDomains.join(" "));
		else s.excludedDomains = legacySkipYouTube === false ? [] : [...DEFAULT_EXCLUDED];
		delete (s as unknown as Record<string, unknown>).skipYouTube;

		if (!s.exclusionsCleaned) {
			s.excludedDomains = s.excludedDomains.filter((domain) => domain !== "youtube-nocookie.com");
			if (s.excludedDomains.length === 0 && legacySkipYouTube !== false) s.excludedDomains = [...DEFAULT_EXCLUDED];
			s.exclusionsCleaned = true;
			this.persistSoon();
		}
		const clamp = (value: number, min: number, max: number, fallback: number): number =>
			Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
		s.columns = clamp(s.columns, 1, 4, 1);
		if (s.layout !== "vertical") s.layout = "horizontal";

		if ((s.cardBackground as string) === "visible") s.cardBackground = "edge";
		if ((s.cardBackground as string) === "invisible") s.cardBackground = "transparent";
		if (s.cardBackground !== "transparent" && s.cardBackground !== "padded" && s.cardBackground !== "overlay") s.cardBackground = "edge";

		if (Platform.isMobile && data?.columns === undefined) s.columns = 2;

		for (const key of ["mobileLayout", "mobileColumns"]) {
			delete (s as unknown as Record<string, unknown>)[key];
		}
		s.marginTop = clamp(s.marginTop, 0, 64, 16);
		s.marginBottom = clamp(s.marginBottom, 0, 64, 30);
		s.gapHorizontal = clamp(s.gapHorizontal, 0, 48, 12);
		s.gapVertical = clamp(s.gapVertical, 0, 64, 12);
		s.titleSize = clamp(s.titleSize, 10, 22, 14);
		s.faviconSize = clamp(s.faviconSize, 10, 32, 16);
		s.noteWidth = clamp(s.noteWidth, 500, 2000, 1000);
		s.customNoteWidth = s.customNoteWidth === true;
		s.playerWidth = clamp(s.playerWidth, 320, 1280, 720);

		if (!data?.screenshotSizeReset) {
			s.screenshotWidth = 1024;
			s.screenshotSizeReset = true;
			this.persistSoon();
		}
		s.screenshotWidth = clamp(s.screenshotWidth, 384, 1920, 1024);
		s.screenshotSaveWidth = clamp(s.screenshotSaveWidth, 320, 1920, 1024);
		delete (s as unknown as Record<string, unknown>).screenshotQuality;
		if (s.screenshotTheme !== "dark") s.screenshotTheme = "light";
		s.titleLines = s.titleLines === 1 || s.titleLines === 0 ? s.titleLines : 2;
		if (s.titleSource !== "website") s.titleSource = "markdown";
		s.preloadImages = s.preloadImages !== false;

		let removed = 0;
		for (const key of Object.keys(s.cache)) {
			const entry = s.cache[key];
			if (!entry || entry.v !== CACHE_VERSION || Date.now() - entry.at > CACHE_MAX_AGE) {
				delete s.cache[key];
				removed++;
			}
		}
		if (removed > 0) this.persistSoon();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	refresh(rerender: boolean): void {
		const s = this.settings;
		const body = document.body;
		const mobile = Platform.isMobile;
		const plain = s.cardBackground === "transparent";

		// The overlay style is always a full-size thumbnail, so it ignores the horizontal layout.
		const layout = s.cardBackground === "overlay" ? "vertical" : s.layout;
		const columns = mobile ? (layout === "horizontal" ? 1 : Math.min(s.columns, 3)) : s.columns;
		body.classList.toggle("wlg-plain", plain);
		body.classList.toggle("wlg-padded", s.cardBackground === "padded");
		body.classList.toggle("wlg-overlay", s.cardBackground === "overlay");

		body.classList.toggle("wlg-horizontal", layout === "horizontal");
		body.classList.toggle("wlg-vertical", layout === "vertical");
		body.classList.toggle("wlg-hovercard", s.hoverCard);
		body.classList.toggle("wlg-zoom", s.hoverZoom);
		body.classList.toggle("wlg-no-description", !s.showDescription);
		body.classList.toggle("wlg-no-domain", !s.showDomain);
		body.classList.toggle("wlg-no-favicon", !s.showFavicon);
		body.style.setProperty("--wlg-columns", String(columns));
		body.style.setProperty("--wlg-mt", `${s.marginTop}px`);
		body.style.setProperty("--wlg-mb", `${s.marginBottom}px`);
		body.style.setProperty("--wlg-hgap", `${s.gapHorizontal}px`);
		body.style.setProperty("--wlg-vgap", `${s.gapVertical}px`);
		body.style.setProperty("--wlg-title-size", `${s.titleSize}px`);
		body.style.setProperty("--wlg-favicon-size", `${s.faviconSize}px`);
		body.style.setProperty("--wlg-player-width", `${s.playerWidth}px`);
		body.style.setProperty("--wlg-title-lines", s.titleLines > 0 ? String(s.titleLines) : "none");
		if (s.customNoteWidth && !mobile) body.style.setProperty("--file-line-width", `${s.noteWidth}px`);
		else body.style.removeProperty("--file-line-width");
		if (rerender) this.rerenderViews();
	}

	async clearCache(): Promise<void> {
		this.settings.cache = {};
		this.failed.clear();
		await this.saveSettings();
		this.rerenderViews();
	}

	private rerenderViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
		}
	}

	private isExcluded(hostname: string): boolean {
		const host = hostname.toLowerCase().replace(/^www\./, "");
		return this.settings.excludedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
	}

	private eligibleAnchor(node: Node): HTMLAnchorElement | null {
		if (node.nodeName !== "A") return null;
		const anchor = node as HTMLAnchorElement;
		if (anchor.hasClass("internal-link") || anchor.hasClass("tag")) return null;
		const url = safeUrl(anchor.getAttribute("href") ?? "");
		if (!url) return null;
		if (this.isExcluded(url.hostname)) return null;
		return anchor;
	}

	private isBlank(node: Node): boolean {
		return (
			node.nodeName === "BR" ||
			(node.nodeType === Node.TEXT_NODE && /^[\s\u200b-\u200f\u00a0\u2060\ufeff]*$/.test(node.textContent ?? ""))
		);
	}

	private processSection(el: HTMLElement): void {
		if (!this.settings.enabled) return;

		const paragraphs = el.matches("p") ? [el] : Array.from(el.querySelectorAll<HTMLElement>("p"));
		for (const paragraph of paragraphs) {
			if (!paragraph.parentElement || paragraph.hasClass("wlg-source")) continue;
			if (paragraph.closest("li, blockquote, table, .callout")) continue;
			this.processParagraph(paragraph);
		}

		const lists = el.matches("ul, ol") ? [el] : Array.from(el.querySelectorAll<HTMLElement>("ul, ol"));
		for (const list of lists) {
			if (!list.parentElement || list.closest(".wlg-source, blockquote, table, .callout")) continue;
			this.processList(list);
		}
	}

	private processParagraph(paragraph: HTMLElement): void {
		const lines: Node[][] = [[]];
		for (const node of Array.from(paragraph.childNodes)) {
			if (node.nodeName === "BR") {
				lines.push([]);
			} else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").includes("\n")) {
				const parts = (node.textContent ?? "").split("\n");
				parts.forEach((part, i) => {
					if (i > 0) lines.push([]);
					if (part) lines[lines.length - 1].push(document.createTextNode(part));
				});
			} else {
				lines[lines.length - 1].push(node);
			}
		}

		type Group = { links: boolean; anchors: HTMLAnchorElement[]; lines: Node[][] };
		const groups: Group[] = [];
		let linkLines = 0;
		for (const line of lines) {
			const content = line.filter((n) => !this.isBlank(n));
			if (content.length === 0) continue;
			const anchor = content.length === 1 ? this.eligibleAnchor(content[0]) : null;
			const isLink = anchor !== null;
			if (isLink) linkLines++;
			let group = groups[groups.length - 1];
			if (!group || group.links !== isLink) {
				group = { links: isLink, anchors: [], lines: [] };
				groups.push(group);
			}
			if (anchor) group.anchors.push(anchor);
			else group.lines.push(content);
		}
		if (linkLines === 0) return;

		for (const group of groups) {
			if (group.links) {
				paragraph.before(this.buildGallery(group.anchors));
			} else {
				const textParagraph = createEl("p");
				group.lines.forEach((content, i) => {
					if (i > 0) textParagraph.append(createEl("br"));
					textParagraph.append(...content);
				});
				paragraph.before(textParagraph);
			}
		}
		paragraph.addClass("wlg-source");
	}

	private listItemAnchor(li: HTMLElement): HTMLAnchorElement | null {
		if (li.matches(".wlg-source, .wlg-list-gallery")) return null;
		const decoration = ".list-bullet, .list-collapse-indicator, .collapse-indicator";
		const content = (node: ChildNode): ChildNode[] =>
			Array.from(node.childNodes).filter(
				(n) => !this.isBlank(n) && !(n.instanceOf(HTMLElement) && n.matches(decoration)),
			);

		let nodes = content(li);
		if (nodes.length === 1 && nodes[0].nodeName === "P") nodes = content(nodes[0]);
		if (nodes.length !== 1) return null;
		return this.eligibleAnchor(nodes[0]);
	}

	private processList(list: HTMLElement): void {
		if (list.hasClass("wlg-source")) return;
		const entries = Array.from(list.children).filter((child): child is HTMLElement => child.tagName === "LI");
		let i = 0;
		while (i < entries.length) {
			const head = this.listItemAnchor(entries[i]);
			if (!head) {
				i++;
				continue;
			}
			const run: HTMLElement[] = [entries[i]];
			const anchors: HTMLAnchorElement[] = [head];
			let end = i + 1;
			for (; end < entries.length; end++) {
				const next = this.listItemAnchor(entries[end]);
				if (!next) break;
				run.push(entries[end]);
				anchors.push(next);
			}
			i = end;

			const gallery = this.buildGallery(anchors);
			if (run.length === entries.length) {
				list.before(gallery);
				list.addClass("wlg-source");
			} else {
				const holder = createEl("li", { cls: "wlg-list-gallery" });
				holder.append(gallery);
				run[0].before(holder);
				for (const li of run) li.addClass("wlg-source");
			}
		}
	}

	private buildGallery(anchors: HTMLAnchorElement[]): HTMLElement {
		const sourcePath = this.renderSource;
		const gallery = createDiv({ cls: "wlg-gallery" });
		const queue = anchors.map((a) => a.getAttribute("href") ?? "").filter((href) => safeUrl(href));
		let index = 0;
		for (const anchor of anchors) {
			const href = anchor.getAttribute("href") ?? "";
			const text = anchor.textContent?.trim() ?? "";
			const valid = safeUrl(href) !== null;
			this.renderCard(gallery, href, /^https?:\/\//i.test(text) ? "" : text, queue, index, sourcePath);
			if (valid) index++;
		}
		return gallery;
	}

	private observers = new Set<IntersectionObserver>();
	private observerMap = new WeakMap<object, Map<number, IntersectionObserver>>();
	private pendingLoads = new WeakMap<Element, () => void>();

	private whenNear(el: HTMLElement, start: () => void): void {
		if (typeof IntersectionObserver === "undefined") {
			start();
			return;
		}
		let frames = 0;
		const attach = (): void => {
			if (!el.isConnected) {
				if (++frames < 600) window.requestAnimationFrame(attach);
				else start();
				return;
			}
			const margin = this.settings.preloadImages ? PRELOAD_MARGIN : 0;
			const root = scrollParent(el);
			const key: object = root ?? document;
			let byMargin = this.observerMap.get(key);
			if (!byMargin) {
				byMargin = new Map();
				this.observerMap.set(key, byMargin);
			}
			let observer = byMargin.get(margin);
			if (!observer) {
				const created: IntersectionObserver = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (!entry.isIntersecting) continue;
							created.unobserve(entry.target);
							const run = this.pendingLoads.get(entry.target);
							this.pendingLoads.delete(entry.target);
							run?.();
						}
					},
					{ root, rootMargin: `${margin}px 0px` },
				);
				observer = created;
				byMargin.set(margin, created);
				this.observers.add(created);
			}
			this.pendingLoads.set(el, start);
			observer.observe(el);
		};
		attach();
	}

	private renderCard(
		parent: HTMLElement,
		href: string,
		label: string,
		queue: string[] = [],
		queueIndex = 0,
		sourcePath = "",
	): void {
		const url = safeUrl(href);
		if (!url) return;

		const card = parent.createEl("a", {
			cls: "wlg-card",
			attr: { href, target: "_blank", rel: "noopener noreferrer" },
		});
		card.addEventListener("click", (evt) => {
			evt.preventDefault();
			if (this.canOpenInWindow() && !evt.ctrlKey && !evt.metaKey) this.openWebsite(queue.length ? queue : [href], queueIndex);
			else window.open(href, "_blank");
		});

		const thumb = card.createDiv({ cls: "wlg-thumb" });
		const img = thumb.createEl("img", { attr: { alt: "", decoding: "async", referrerpolicy: "no-referrer" } });

		const text = card.createDiv({ cls: "wlg-text" });
		const titleEl = text.createDiv({ cls: "wlg-title", text: label || hostLabel(url) });
		const descEl = text.createDiv({ cls: "wlg-description" });
		const domain = text.createDiv({ cls: "wlg-domain" });
		const domainIcon = domain.createEl("img", {
			cls: "wlg-domain-icon",
			attr: { alt: "", decoding: "async", referrerpolicy: "no-referrer" },
		});
		domainIcon.hide();
		domainIcon.addEventListener("error", () => domainIcon.hide());
		domain.createSpan({ cls: "wlg-domain-name", text: hostLabel(url) });

		card.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();
			(menu as Menu & { dom?: HTMLElement }).dom?.addClass("wlg-menu");
			if (this.canOpenInWindow()) {
				menu.addItem((item) =>
					item
						.setTitle("Open in Obsidian")
						.setIcon("picture-in-picture-2")
						.onClick(() => this.openWebsite(queue.length ? queue : [href], queueIndex)),
				);
			}
			menu.addItem((item) =>
				item.setTitle("Open in browser").setIcon("external-link").onClick(() => window.open(href, "_blank")),
			);
			menu.addSeparator();
			const hasShot = this.screenshotSrc(url.href) !== null;

			const showsPageImage = !hasShot;
			if (Platform.isDesktopApp) {
				menu.addItem((item) =>
					titleWithCheck(this.app, item, "Screenshot", hasShot)
						.setIcon("camera")
						.setDisabled(hasShot)
						.onClick(() => {
							void this.takeScreenshot(url.href).then((ok) => {
								if (ok) rebuild();
							});
						}),
				);
			}
			menu.addItem((item) =>
				titleWithCheck(this.app, item, "Image / icon", showsPageImage)
					.setIcon("image")
					.setDisabled(!hasShot)
					.onClick(() => {
						void this.removeScreenshot(url.href).then(() => rebuild());
					}),
			);
			if (Platform.isDesktopApp && queue.length > 1) {
				menu.addItem((item) =>
					item
						.setTitle("Gallery: Screenshot all")
						.setIcon("images")
						.onClick(() => void this.screenshotAll(queue)),
				);
				menu.addItem((item) =>
					item
						.setTitle("Gallery: Fill in missing")
						.setIcon("image-down")
						.onClick(() => void this.screenshotAll(queue, true)),
				);
			}
			if (Platform.isDesktopApp) {
				menu.addItem((item) =>
					item
						.setTitle("Note: Screenshot all")
						.setIcon("images")
						.onClick(() => void this.collectNoteLinks(card, sourcePath).then((links) => this.screenshotAll(links))),
				);
				menu.addItem((item) =>
					item
						.setTitle("Note: Fill in missing")
						.setIcon("image-down")
						.onClick(() => void this.collectNoteLinks(card, sourcePath).then((links) => this.screenshotAll(links, true))),
				);
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Copy link").setIcon("link").onClick(() => void this.copyText(href, "Link copied.")),
			);
			menu.addItem((item) =>
				item
					.setTitle("Copy title")
					.setIcon("copy")
					.onClick(() => void this.copyText(titleEl.textContent ?? "", "Title copied.")),
			);
			if (sourcePath) {
				menu.addSeparator();
				menu.addItem((item) =>
					item
						.setTitle("Remove link")
						.setIcon("trash-2")
						.setWarning(true)
						.onClick(() => this.removeLinkFromNote(sourcePath, href, card)),
				);
			}
			menu.showAtMouseEvent(evt);
		});

		let candidates: { src: string; icon: boolean }[] = [];
		let index = 0;
		const apply = (): void => {
			const candidate = candidates[index];
			if (!candidate) {
				thumb.addClass("wlg-thumb-empty");
				return;
			}
			thumb.toggleClass("wlg-thumb-icon", candidate.icon);
			if (img.getAttribute("src") !== candidate.src) img.removeClass("is-loaded");
			img.src = candidate.src;
		};
		const advance = (): void => {
			index++;
			apply();
		};
		img.addEventListener("error", advance);
		img.addEventListener("load", () => {
			const candidate = candidates[index];
			const tooSmall = candidate && !candidate.icon ? img.naturalWidth <= 50 : img.naturalWidth <= 1;
			if (tooSmall) advance();
			else img.addClass("is-loaded");
		});

		const origin = url.origin;
		const fallbackIcons = [
			{ src: `${origin}/favicon.ico`, icon: true },
			{ src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`, icon: true },
		];

		let info: SiteInfo | null = null;
		const rebuild = (): void => {
			const list: { src: string; icon: boolean }[] = [];
			const shot = this.screenshotSrc(url.href);
			if (shot) list.push({ src: shot, icon: false });
			if (info?.image) list.push({ src: info.image, icon: false });
			if (info?.icon) list.push({ src: info.icon, icon: true });
			list.push(...fallbackIcons);
			candidates = list;
			index = 0;
			thumb.removeClass("wlg-thumb-empty");
			apply();
		};

		const registered = { card, rebuild };
		const forKey = this.cardRebuilders.get(url.href) ?? new Set();
		forKey.add(registered);
		this.cardRebuilders.set(url.href, forKey);

		this.whenNear(card, () => {
			if (this.screenshotSrc(url.href)) rebuild();

			void this.getSiteInfo(url.href).then((result) => {
				info = result;
				rebuild();

				if (!info) return;
				if ((this.settings.titleSource === "website" || !label) && info.title) titleEl.setText(info.title);
				descEl.setText(info.description);
				domainIcon.src = info.icon || fallbackIcons[0].src;
				domainIcon.show();
			});
		});
	}

	private wantsTitle(href: string): boolean {
		const url = safeUrl(href);
		if (!url) return false;
		return !this.isExcluded(url.hostname);
	}

	private async fetchTitle(href: string): Promise<string | null> {
		const info = await this.getSiteInfo(href);
		return info?.title || null;
	}

	private handlePaste(evt: ClipboardEvent, editor: Editor): void {
		if (!this.settings.titleOnPaste || evt.defaultPrevented || editor.somethingSelected()) return;
		const text = evt.clipboardData?.getData("text/plain").trim() ?? "";
		if (!/^https?:\/\/\S+$/.test(text) || !this.wantsTitle(text)) return;

		const cursor = editor.getCursor();
		if (/(\]\(|<|\[)$/.test(editor.getLine(cursor.line).slice(0, cursor.ch))) return;
		let fences = 0;
		for (let n = 0; n < cursor.line; n++) {
			if (/^\s*(```|~~~)/.test(editor.getLine(n))) fences++;
		}
		if (fences % 2 === 1) return;

		evt.preventDefault();
		editor.replaceSelection(text);
		const from = cursor;
		const to = editor.getCursor();
		void this.fetchTitle(text).then((title) => {
			if (!title || editor.getRange(from, to) !== text) return;
			const atEnd = editor.getCursor().line === to.line && editor.getCursor().ch === to.ch;
			const link = markdownLink(title, text);
			editor.replaceRange(link, from, to);
			if (atEnd) editor.setCursor(editor.offsetToPos(editor.posToOffset(from) + link.length));
		});
	}

	async scanBareLinks(): Promise<BareScan> {
		const scan: BareScan = { files: [], links: 0, urls: new Set() };
		for (const file of this.app.vault.getMarkdownFiles()) {
			const text = await this.app.vault.cachedRead(file);
			let found = false;
			mapBareLines(
				text,
				(url) => this.wantsTitle(url),
				(url) => {
					found = true;
					scan.links++;
					scan.urls.add(url);
					return null;
				},
			);
			if (found) scan.files.push(file);
		}
		return scan;
	}

	async offerBareLinkConversion(): Promise<void> {
		const scan = await this.scanBareLinks();
		if (scan.urls.size === 0) {
			new Notice("No website links without a title found.");
			return;
		}
		new ConfirmModal(
			this.app,
			"Add titles to links",
			[
				`Found ${plural(scan.links, "website link")} without a title in ${plural(scan.files.length, "note")}.`,
				"Each one becomes a Markdown link with the website's title. Nothing is removed. Consider backing up your vault first.",
			],
			"Add titles",
			() => void this.convertBareLinks(scan),
		).open();
	}

	private async convertBareLinks(scan: BareScan): Promise<void> {
		const progress = new Notice("Fetching titles…", 0);
		const titles = new Map<string, string>();
		const queue = [...scan.urls];
		let done = 0;

		const worker = async (): Promise<void> => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const title = await this.fetchTitle(next);
				if (title) titles.set(next, title);
				done++;
				progress.setMessage(`Fetching titles… ${done}/${scan.urls.size}`);
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);

		let updated = 0;
		for (const file of scan.files) {
			try {
				await this.app.vault.process(file, (data) =>
					mapBareLines(
						data,
						(url) => this.wantsTitle(url),
						(url) => {
							const title = titles.get(url);
							if (!title) return null;
							updated++;
							return markdownLink(title, url);
						},
					),
				);
			} catch {
				// Ignored on purpose: this step is best effort.
			}
		}

		progress.hide();
		const failed = scan.urls.size - titles.size;
		new Notice(
			`Updated ${plural(updated, "website link")}.` +
				(failed > 0 ? ` ${plural(failed, "link")} could not be fetched and ${failed === 1 ? "was" : "were"} left as is.` : ""),
		);
	}

	private canOpenInWindow(): boolean {
		return this.settings.openInWindow && Platform.isDesktopApp;
	}

	private loadWebsite(frame: HTMLElement, href: string): void {
		type Webview = HTMLElement & {
			insertCSS(css: string): Promise<string>;
			executeJavaScript(code: string): Promise<unknown>;
			getURL(): string;
			canGoBack(): boolean;
			goBack(): void;
			capturePage(): Promise<NativeImg>;
		};
		frame.empty();
		const view = createEl("webview" as keyof HTMLElementTagNameMap) as unknown as Webview;
		view.setAttribute("src", href);
		view.setAttribute("partition", "persist:advanced-web-link-features");
		view.addClass("wlg-player-webview");

		const sync = (): void => {
			const player = this.player;
			if (!player || player.frame !== frame) return;
			try {
				const url = view.getURL();
				if (url) {
					player.href = url;
					const parsed = safeUrl(url);
					if (parsed) player.label.setText(addressLabel(parsed, this.settings.showFullAddress));
				}
				player.backButton.toggleClass("is-disabled", !view.canGoBack());
			} catch {
				// Ignored on purpose: this step is best effort.
			}
		};
		view.addEventListener("did-navigate", sync);
		view.addEventListener("did-navigate-in-page", sync);
		view.addEventListener("page-title-updated", (evt) => {
			const title = (evt as Event & { title?: string }).title?.trim();
			if (title && this.player?.frame === frame) this.player.label.setAttr("title", title);
		});

		view.addEventListener("dom-ready", () => {
			sync();

			const styles = getComputedStyle(document.body);
			const dark = document.body.hasClass("theme-dark");
			const track = styles.getPropertyValue("--background-primary").trim() || (dark ? "#1e1e1e" : "#ffffff");
			const thumb = styles.getPropertyValue("--scrollbar-thumb-bg").trim() || (dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)");
			void view.insertCSS(`* { scrollbar-color: ${thumb} ${track} !important; }`);

			void view.executeJavaScript(
				`(() => {
					if (window.__wlgLinks) return;
					window.__wlgLinks = true;
					document.addEventListener("click", (e) => {
						const a = e.target && e.target.closest ? e.target.closest("a[target=_blank]") : null;
						if (a && /^https?:/i.test(a.href) && !e.defaultPrevented && !e.ctrlKey && !e.metaKey) {
							e.preventDefault();
							location.href = a.href;
						}
					}, true);
				})();`,
			);
		});
		this.backTarget = view;
		frame.append(view);
	}

	private syncPlayer(): void {
		const player = this.player;
		if (!player) return;
		player.href = player.queue[player.index] ?? player.href;
		const url = safeUrl(player.href);
		player.label.setText(url ? addressLabel(url, this.settings.showFullAddress) : player.href);
		player.label.removeAttribute("title");
		player.backButton.addClass("is-disabled");
		player.previousButton.toggleClass("is-disabled", player.index <= 0);
		player.nextButton.toggleClass("is-disabled", player.index >= player.queue.length - 1);
		player.previousButton.toggleVisibility(player.queue.length > 1);
		player.nextButton.toggleVisibility(player.queue.length > 1);
		this.loadWebsite(player.frame, player.href);
	}

	private stepQueue(direction: 1 | -1): void {
		const player = this.player;
		if (!player) return;
		const next = player.index + direction;
		if (next < 0 || next >= player.queue.length) return;
		player.index = next;
		this.syncPlayer();
	}

	private openWebsite(queue: string[], index: number): void {
		if (this.player) {
			Object.assign(this.player, { queue, index });
			this.syncPlayer();
			return;
		}

		const el = document.body.createDiv({ cls: "wlg-player" });
		const bar = el.createDiv({ cls: "wlg-player-bar" });
		const grip = bar.createDiv({ cls: "wlg-player-grip" });
		setIcon(grip.createSpan({ cls: "wlg-player-grip-icon" }), "grip-horizontal");
		const label = grip.createSpan({ cls: "wlg-player-label" });
		const backButton = bar.createEl("button", { cls: "wlg-player-btn is-disabled", attr: { "aria-label": "Back" } });
		setIcon(backButton, "arrow-left");
		const previousButton = bar.createEl("button", { cls: "wlg-player-btn", attr: { "aria-label": "Previous website" } });
		setIcon(previousButton, "skip-back");
		const nextButton = bar.createEl("button", { cls: "wlg-player-btn", attr: { "aria-label": "Next website" } });
		setIcon(nextButton, "skip-forward");
		const shotButton = bar.createEl("button", { cls: "wlg-player-btn", attr: { "aria-label": "Use a screenshot of this page as the thumbnail" } });
		setIcon(shotButton, "camera");
		const copyButton = bar.createEl("button", { cls: "wlg-player-btn", attr: { "aria-label": "Copy link" } });
		setIcon(copyButton, "copy");
		const openButton = bar.createEl("button", { cls: "wlg-player-btn", attr: { "aria-label": "Open in browser" } });
		setIcon(openButton, "arrow-up-right");
		const closeButton = bar.createEl("button", { cls: "wlg-player-btn wlg-player-close", attr: { "aria-label": "Close" } });
		setIcon(closeButton, "x");
		const frame = el.createDiv({ cls: "wlg-player-frame" });

		const place = (left: number, top: number): void => {
			const rect = el.getBoundingClientRect();
			const x = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - rect.width));
			const y = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - rect.height));
			el.setCssProps({ left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto", transform: "none" });
		};

		let grab: { dx: number; dy: number } | null = null;
		grip.addEventListener("pointerdown", (evt) => {
			const rect = el.getBoundingClientRect();
			grab = { dx: evt.clientX - rect.left, dy: evt.clientY - rect.top };
			grip.setPointerCapture(evt.pointerId);
			el.addClass("is-dragging");
			evt.preventDefault();
		});
		grip.addEventListener("pointermove", (evt) => {
			if (grab) place(evt.clientX - grab.dx, evt.clientY - grab.dy);
		});
		const drop = (evt: PointerEvent): void => {
			if (!grab) return;
			grab = null;
			grip.releasePointerCapture(evt.pointerId);
			el.removeClass("is-dragging");
		};
		grip.addEventListener("pointerup", drop);
		grip.addEventListener("pointercancel", drop);

		const MIN_WIDTH = 320;
		const MIN_HEIGHT = 240;
		const barHeight = (): number => bar.getBoundingClientRect().height;
		const setFrameHeight = (height: number): void => {
			frame.addClass("is-resized");
			frame.setCssProps({ height: `${height}px` });
		};
		type Edge = "e" | "w" | "s" | "se" | "sw";
		for (const edge of ["e", "w", "s", "se", "sw"] as Edge[]) {
			const handle = el.createDiv({ cls: `wlg-player-resize wlg-resize-${edge}` });
			let start: { x: number; y: number; left: number; top: number; width: number; height: number } | null = null;
			handle.addEventListener("pointerdown", (evt) => {
				const rect = el.getBoundingClientRect();
				place(rect.left, rect.top);
				start = {
					x: evt.clientX,
					y: evt.clientY,
					left: rect.left,
					top: rect.top,
					width: rect.width,
					height: frame.getBoundingClientRect().height,
				};
				handle.setPointerCapture(evt.pointerId);
				el.addClass("is-dragging");
				evt.preventDefault();
				evt.stopPropagation();
			});
			handle.addEventListener("pointermove", (evt) => {
				if (!start) return;
				const dx = evt.clientX - start.x;
				const dy = evt.clientY - start.y;
				const fromLeft = edge === "w" || edge === "sw";
				if (edge !== "s") {
					let width = fromLeft ? start.width - dx : start.width + dx;
					const room = fromLeft ? start.left + start.width : window.innerWidth - start.left;
					width = Math.max(MIN_WIDTH, Math.min(width, window.innerWidth, room));
					el.style.setProperty("width", `${width}px`);
					if (fromLeft) el.style.setProperty("left", `${start.left + start.width - width}px`);
				}
				if (edge === "s" || edge === "se" || edge === "sw") {
					const room = window.innerHeight - start.top - barHeight();
					setFrameHeight(Math.max(MIN_HEIGHT, Math.min(start.height + dy, room)));
				}
				place(parseFloat(el.style.left), parseFloat(el.style.top));
			});
			const release = (evt: PointerEvent): void => {
				if (!start) return;
				start = null;
				handle.releasePointerCapture(evt.pointerId);
				el.removeClass("is-dragging");
			};
			handle.addEventListener("pointerup", release);
			handle.addEventListener("pointercancel", release);
		}

		const onResize = (): void => {
			if (el.style.width && el.offsetWidth > window.innerWidth) el.style.setProperty("width", `${Math.max(MIN_WIDTH, window.innerWidth)}px`);
			const maxFrame = window.innerHeight - barHeight();
			if (frame.style.height && frame.offsetHeight > maxFrame) setFrameHeight(Math.max(MIN_HEIGHT, maxFrame));
			if (el.style.left) place(parseFloat(el.style.left), parseFloat(el.style.top));
		};
		window.addEventListener("resize", onResize);

		backButton.addEventListener("click", () => {
			try {
				if (this.backTarget?.canGoBack()) this.backTarget.goBack();
			} catch {
				// Ignored on purpose: this step is best effort.
			}
		});
		previousButton.addEventListener("click", () => this.stepQueue(-1));
		nextButton.addEventListener("click", () => this.stepQueue(1));

		let shotTimer = 0;
		shotButton.addEventListener("click", () => {
			const current = this.player;
			if (!current || shotButton.hasClass("is-disabled")) return;

			shotButton.addClass("is-disabled");
			void this.screenshotWindow().then((ok) => {
				shotButton.removeClass("is-disabled");
				if (!ok) return;
				setIcon(shotButton, "check");
				window.clearTimeout(shotTimer);
				shotTimer = window.setTimeout(() => setIcon(shotButton, "camera"), 1200);
			});
		});

		let copyTimer = 0;
		copyButton.addEventListener("click", () => {
			void this.copyText(this.player?.href ?? "", "Link copied.");
			setIcon(copyButton, "check");
			window.clearTimeout(copyTimer);
			copyTimer = window.setTimeout(() => setIcon(copyButton, "copy"), 1200);
		});
		openButton.addEventListener("click", () => {
			const href = this.player?.href;
			if (href) window.open(href, "_blank");
			this.closePlayer();
		});
		closeButton.addEventListener("click", () => this.closePlayer());

		this.player = { el, frame, label, backButton, previousButton, nextButton, href: queue[index] ?? "", queue, index, onResize };
		this.syncPlayer();

		const rect = el.getBoundingClientRect();
		place((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
	}

	updatePlayerLabel(): void {
		const player = this.player;
		const url = player ? safeUrl(player.href) : null;
		if (player && url) player.label.setText(addressLabel(url, this.settings.showFullAddress));
	}

	private closePlayer(): void {
		if (!this.player) return;
		window.removeEventListener("resize", this.player.onResize);
		this.player.el.remove();
		this.player = null;
		this.backTarget = null;
	}

	async copyText(text: string, done: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(done);
		} catch {
			new Notice("Could not copy.");
		}
	}

	private screenshotDir(): string {
		return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/screenshots`;
	}

	private screenshotSrc(href: string): string | null {
		const file = this.settings.screenshots[href];
		if (!file) return null;
		const adapter = this.app.vault.adapter as { getResourcePath?: (path: string) => string };
		if (!adapter.getResourcePath) return null;
		const src = adapter.getResourcePath(`${this.screenshotDir()}/${file}`);
		const version = this.shotVersion.get(href);
		return version ? `${src}${src.includes("?") ? "&" : "?"}v=${version}` : src;
	}

	private async takeScreenshot(href: string, key: string = href, quiet = false): Promise<boolean> {
		if (!Platform.isDesktopApp || this.shooting.has(key)) return false;
		this.shooting.add(key);
		const notice = quiet ? null : new Notice("Taking screenshot…", 0);

		type Webview = HTMLElement & {
			capturePage(): Promise<NativeImg>;
			setAudioMuted(muted: boolean): void;
			insertCSS(css: string): Promise<string>;
			executeJavaScript(code: string): Promise<unknown>;
			getWebContentsId(): number;
		};

		let themeReady: Promise<() => void> = Promise.resolve(() => undefined);
		const width = this.settings.screenshotWidth;
		const height = Math.round((width * 9) / 16);
		const host = document.body.createDiv({ cls: "wlg-shot-host" });
		host.setCssProps({ width: `${width}px`, height: `${height}px` });
		const view = createEl("webview" as keyof HTMLElementTagNameMap) as unknown as Webview;
		view.setAttribute("src", href);

		view.setAttribute("partition", "wlg-screenshot");
		view.addClass("wlg-shot-view");
		view.setCssProps({ width: `${width}px`, height: `${height}px` });

		try {
			await new Promise<void>((resolve, reject) => {
				const timer = window.setTimeout(resolve, 20000);
				view.addEventListener("dom-ready", () => {
					try {
						view.setAudioMuted(true);
					} catch {
						// Ignored on purpose: this step is best effort.
					}
					themeReady = emulateTheme(view, this.settings.screenshotTheme);
				});
				view.addEventListener("did-fail-load", (evt) => {
					const e = evt as Event & { errorCode?: number; isMainFrame?: boolean };
					if (e.isMainFrame && e.errorCode !== -3) {
						window.clearTimeout(timer);
						reject(new Error("The page could not be loaded."));
					}
				});
				view.addEventListener("did-finish-load", () => {
					window.clearTimeout(timer);
					resolve();
				});
				host.append(view);
			});
			try {
				await view.insertCSS(HIDE_SCROLLBAR_CSS);
			} catch {
				// Ignored on purpose: this step is best effort.
			}
			const hideBanners = async (): Promise<void> => {
				if (!this.settings.hideCookieBanners) return;
				try {
					await view.insertCSS(COOKIE_BANNER_CSS);
					await view.executeJavaScript(COOKIE_BANNER_SCRIPT);
				} catch {
					// Ignored on purpose: this step is best effort.
				}
			};

			await hideBanners();

			for (const pause of [2500, 2000]) {
				await new Promise((resolve) => window.setTimeout(resolve, pause));
				await hideBanners();
			}
			await new Promise((resolve) => window.setTimeout(resolve, 200));

			let shot = await view.capturePage();
			if (!shot || shot.isEmpty()) {
				await new Promise((resolve) => window.setTimeout(resolve, 1500));
				shot = await view.capturePage();
			}
			await this.saveScreenshotImage(key, shot);
			notice?.setMessage("Screenshot saved.");
			window.setTimeout(() => notice?.hide(), 2000);
			return true;
		} catch (error) {
			notice?.hide();
			if (!quiet) new Notice(`Screenshot failed: ${error instanceof Error ? error.message : "unknown error"}`);
			return false;
		} finally {
			void themeReady.then((release) => release());
			host.remove();
			this.shooting.delete(key);
		}
	}

	private removeLinkFromNote(sourcePath: string, href: string, card: HTMLElement): void {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			new Notice("Could not find the note this link is in.");
			return;
		}
		void this.removeLink(file, href, card);
	}

	private async removeLink(file: TFile, href: string, card: HTMLElement): Promise<void> {
		let found = false;
		try {
			await this.app.vault.process(file, (data) => {
				const result = removeLinkLine(data, href);
				if (result === null) return data;
				found = true;
				return result;
			});
		} catch {
			new Notice("The note could not be changed.");
			return;
		}
		if (!found) {
			new Notice("Could not find this link as its own line in the note.");
			return;
		}
		card.remove();
		new Notice("Link removed.");
	}

	private async collectNoteLinks(card: HTMLElement, sourcePath: string): Promise<string[]> {
		const links: string[] = [];
		const root = card.closest(".markdown-reading-view, .markdown-source-view, .workspace-leaf-content");
		if (root) {
			for (const el of Array.from(root.querySelectorAll(".wlg-card[href]"))) links.push(el.getAttribute("href") ?? "");
		}
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (file instanceof TFile) {
			try {
				links.push(...standaloneLinks(await this.app.vault.cachedRead(file)));
			} catch {
				// Ignored on purpose: this step is best effort.
			}
		}
		return links;
	}

	private async lacksGoodImage(href: string): Promise<boolean> {
		if (this.settings.screenshots[href]) return false;
		const info = await this.getSiteInfo(href);
		if (!info?.image) return true;
		return new Promise<boolean>((resolve) => {
			const probe = new Image();
			probe.referrerPolicy = "no-referrer";
			const timer = window.setTimeout(() => resolve(true), 8000);
			const finish = (weak: boolean): void => {
				window.clearTimeout(timer);
				resolve(weak);
			};
			probe.onload = () => finish(probe.naturalWidth < LOW_IMAGE_WIDTH);
			probe.onerror = () => finish(true);
			probe.src = info.image;
		});
	}

	private async screenshotAll(links: string[], weakOnly = false): Promise<void> {
		if (!Platform.isDesktopApp) return;
		if (this.batchRunning) {
			new Notice("Screenshots are already being taken.");
			return;
		}
		const unique = [...new Set(links.map((link) => safeUrl(link)?.href).filter((link): link is string => !!link))];
		let todo = unique.filter((link) => !this.settings.screenshots[link]);
		if (todo.length === 0) {
			new Notice("Every link here already has a screenshot.");
			return;
		}

		this.batchRunning = true;
		const notice = new Notice("", 0);
		let done = 0;
		let failed = 0;
		try {
			if (weakOnly) {
				notice.setMessage("Checking thumbnails…");
				const weak = new Set<string>();
				const pending = [...todo];
				const check = async (): Promise<void> => {
					for (let href = pending.shift(); href; href = pending.shift()) {
						if (await this.lacksGoodImage(href)) weak.add(href);
					}
				};
				await Promise.all([check(), check(), check(), check()]);
				todo = todo.filter((link) => weak.has(link));
				if (todo.length === 0) {
					notice.setMessage("Every thumbnail here already looks good.");
					window.setTimeout(() => notice.hide(), 4000);
					return;
				}
			}
			const skipped = unique.length - todo.length;
			const update = (): void => {
				notice.setMessage(`Taking screenshots… ${done + failed}/${todo.length}`);
			};
			update();
			const run = async (list: string[], workers: number): Promise<string[]> => {
				const queue = [...list];
				const failedLinks: string[] = [];
				const worker = async (): Promise<void> => {
					for (let href = queue.shift(); href; href = queue.shift()) {
						if (await this.takeScreenshot(href, href, true)) done++;
						else failedLinks.push(href);
						failed = failedLinks.length;
						update();
					}
				};
				await Promise.all(Array.from({ length: workers }, () => worker()));
				return failedLinks;
			};

			let remaining = await run(todo, 3);
			for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt++) {
				notice.setMessage(`Retrying ${remaining.length} that failed…`);
				remaining = await run(remaining, 1);
			}
			failed = remaining.length;
			const parts = [`${done} saved`];
			if (failed) parts.push(`${failed} failed, run it again to retry those`);
			if (skipped) parts.push(weakOnly ? `${skipped} already fine` : `${skipped} already had one`);
			notice.setMessage(`Screenshots done: ${parts.join(", ")}.`);
			window.setTimeout(() => notice.hide(), failed ? 10000 : 5000);
		} finally {
			this.batchRunning = false;
		}
	}

	private async saveScreenshotImage(key: string, captured: NativeImg): Promise<void> {
		let image = captured;
		if (!image || image.isEmpty()) throw new Error("The page came back blank.");
		const saveWidth = this.settings.screenshotSaveWidth;
		if (image.getSize().width > saveWidth) image = image.resize({ width: saveWidth, quality: "best" });
		const bytes = image.toJPEG(SCREENSHOT_JPEG_QUALITY);
		const data = new Uint8Array(bytes).buffer;

		const adapter = this.app.vault.adapter;
		const dir = this.screenshotDir();
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		const file = `${hashString(key)}.jpg`;
		await adapter.writeBinary(`${dir}/${file}`, data);
		this.settings.screenshots[key] = file;
		this.shotVersion.set(key, Date.now());
		await this.saveSettings();
		this.refreshCards(key);
	}

	refreshCards(key: string): void {
		const cards = this.cardRebuilders.get(key);
		if (!cards) return;
		for (const entry of [...cards]) {
			if (!entry.card.isConnected) cards.delete(entry);
			else entry.rebuild();
		}
	}

	async screenshotWindow(): Promise<boolean> {
		const player = this.player;
		const view = this.backTarget;
		if (!player || !view) return false;
		const origin = player.queue[player.index] ?? player.href;

		const key = safeUrl(origin)?.href ?? origin;
		try {
			await this.saveScreenshotImage(key, await view.capturePage());
			new Notice("Screenshot saved.");
			return true;
		} catch (error) {
			new Notice(`Screenshot failed: ${error instanceof Error ? error.message : "unknown error"}`);
			return false;
		}
	}

	screenshotCount(): number {
		return Object.keys(this.settings.screenshots).length;
	}

	async removeAllScreenshots(): Promise<number> {
		const saved = Object.entries(this.settings.screenshots);
		this.settings.screenshots = {};
		this.shotVersion.clear();
		await this.saveSettings();
		for (const [, file] of saved) {
			try {
				await this.app.vault.adapter.remove(`${this.screenshotDir()}/${file}`);
			} catch {
				// Ignored on purpose: this step is best effort.
			}
		}
		for (const [key] of saved) this.refreshCards(key);
		return saved.length;
	}

	private async removeScreenshot(href: string): Promise<void> {
		const file = this.settings.screenshots[href];
		if (!file) return;
		delete this.settings.screenshots[href];
		await this.saveSettings();
		try {
			await this.app.vault.adapter.remove(`${this.screenshotDir()}/${file}`);
		} catch {
			// Ignored on purpose: this step is best effort.
		}
		this.refreshCards(href);
	}

	private async getSiteInfo(href: string): Promise<SiteInfo | null> {
		const cached = this.settings.cache[href];
		if (cached && cached.v === CACHE_VERSION && Date.now() - cached.at <= CACHE_MAX_AGE) return cached;
		if (this.failed.has(href)) return null;

		let request = this.pending.get(href);
		if (!request) {
			request = this.fetchSite(href)
				.then((info) => {
					if (info) {
						this.settings.cache[href] = info;
						this.persistSoon();
					} else {
						this.failed.add(href);
					}
					return info;
				})
				.finally(() => this.pending.delete(href));
			this.pending.set(href, request);
		}
		return request;
	}

	private async fetchSite(href: string): Promise<SiteInfo | null> {
		try {
			const res = await requestUrl({
				url: href,
				headers: {
					Accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
					"Accept-Language": "en-US,en;q=0.9",
				},
				throw: false,
			});
			if (res.status < 200 || res.status >= 300) return null;

			const type = headerValue(res.headers, "content-type").toLowerCase();
			if (type.startsWith("image/")) {
				return { at: Date.now(), title: "", description: "", image: href, icon: "", v: CACHE_VERSION };
			}
			if (type && !type.includes("html") && !type.includes("xml")) return null;

			const parsed = parseSite(res.text, href);
			return { ...parsed, at: Date.now(), v: CACHE_VERSION };
		} catch {
			return null;
		}
	}
}

class WebsiteGallerySettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: WebsiteGalleryPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		const commit = async (rerender: boolean): Promise<void> => {
			await this.plugin.saveSettings();
			this.plugin.refresh(rerender);
		};

		const group = (name: string, desc?: string): HTMLElement => {
			const heading = new Setting(containerEl).setName(name).setHeading();
			heading.settingEl.addClass("wlg-settings-section");
			return containerEl.createDiv({ cls: "wlg-settings-card" });
		};
		const divider = (card: HTMLElement): void => {
			card.createEl("hr", { cls: "wlg-settings-divider" });
		};
		const slider = (
			card: HTMLElement,
			name: string,
			key: "marginTop" | "marginBottom" | "gapHorizontal" | "gapVertical" | "titleSize" | "playerWidth" | "screenshotWidth" | "screenshotSaveWidth",
			min: number,
			max: number,
			step: number,
		): void => {
			new Setting(card)
				.setName(name)
				.addSlider((s) =>
					s
						.setLimits(min, max, step)
						.setValue(settings[key])
						.onChange(async (value) => {
							settings[key] = value;
							await commit(false);
						}),
				);
		};
		const linkButton = (setting: Setting, text: string, url: string): void => {
			setting.addButton((button) => {
				button.setButtonText(text).onClick(() => {
					window.open(url, "_blank");
				});
				setIcon(button.buttonEl.createSpan({ cls: "wlg-link-icon" }), "arrow-up-right");
			});
		};

		const main = group("Advanced Web Link Features");

		new Setting(main)
			.setName("Turn website links into preview cards")
			.addToggle((toggle) =>
				toggle.setValue(settings.enabled).onChange(async (value) => {
					settings.enabled = value;
					await commit(true);
				}),
			);

		if (Platform.isDesktopApp) {
			divider(main);
			new Setting(main)
				.setName("Open websites in a floating window inside Obsidian")
				.addToggle((toggle) =>
					toggle.setValue(settings.openInWindow).onChange(async (value) => {
						settings.openInWindow = value;
						await commit(false);
					}),
				);
		}

		const appearance = group("Appearance");

		new Setting(appearance)
			.setName("Card background")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("transparent", "Transparent")
					.addOption("padded", "Padded")
					.addOption("edge", "Edge to edge")
					.addOption("overlay", "Overlay")
					.setValue(settings.cardBackground)
					.onChange(async (value) => {
						settings.cardBackground = value as CardBackground;
						await commit(false);
					}),
			);
		divider(appearance);
		new Setting(appearance)
			.setName("Card layout")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("horizontal", "Horizontal")
					.addOption("vertical", "Vertical")
					.setValue(settings.layout)
					.onChange(async (value) => {
						settings.layout = value as CardLayout;
						await commit(false);
					}),
			);
		divider(appearance);
		new Setting(appearance)
			.setName("Cards per row")
			.addDropdown((dropdown) => {
				dropdown.addOption("1", "1").addOption("2", "2").addOption("3", "3");
				if (!Platform.isMobile) dropdown.addOption("4", "4");
				dropdown.setValue(String(Math.min(settings.columns, Platform.isMobile ? 3 : 4))).onChange(async (value) => {
					settings.columns = Number(value);
					await commit(false);
				});
			});
		divider(appearance);
		slider(appearance, "Margin above each gallery", "marginTop", 0, 64, 2);
		divider(appearance);
		slider(appearance, "Margin below each gallery", "marginBottom", 0, 64, 2);
		divider(appearance);
		slider(appearance, "Horizontal gap between cards", "gapHorizontal", 0, 48, 2);
		divider(appearance);
		slider(appearance, "Vertical gap between cards", "gapVertical", 0, 64, 2);
		divider(appearance);
		slider(appearance, "Title text size", "titleSize", 10, 22, 1);
		if (Platform.isDesktopApp) {
			divider(appearance);
			slider(appearance, "Floating window size", "playerWidth", 320, 1280, 40);
		}
		divider(appearance);
		new Setting(appearance)
			.setName("Highlight on hover")
			.addToggle((toggle) =>
				toggle.setValue(settings.hoverCard).onChange(async (value) => {
					settings.hoverCard = value;
					await commit(false);
				}),
			);
		divider(appearance);
		new Setting(appearance)
			.setName("Zoom image on hover")
			.addToggle((toggle) =>
				toggle.setValue(settings.hoverZoom).onChange(async (value) => {
					settings.hoverZoom = value;
					await commit(false);
				}),
			);
		if (Platform.isDesktopApp) {
			divider(appearance);
			new Setting(appearance)
				.setName("Floating window: show full address")
				.addToggle((toggle) =>
					toggle.setValue(settings.showFullAddress).onChange(async (value) => {
						settings.showFullAddress = value;
						await commit(false);
						this.plugin.updatePlayerLabel();
					}),
				);
		}

		if (!Platform.isMobile) {
			divider(appearance);
			const widthSetting = new Setting(appearance).setName("Increase note width globally");
			const showWidthControls = (visible: boolean): void => {
				widthSetting.controlEl.toggleClass("wlg-width-off", !visible);
			};
			widthSetting
				.addSlider((slider) =>
					slider
						.setLimits(700, 2000, 50)
						.setValue(settings.noteWidth)
						.onChange(async (value) => {
							settings.noteWidth = value;
							await commit(false);
						}),
				)
				.addToggle((toggle) =>
					toggle.setValue(settings.customNoteWidth).onChange(async (value) => {
						settings.customNoteWidth = value;
						showWidthControls(value);
						await commit(false);
					}),
				);
			showWidthControls(settings.customNoteWidth);
		}

		if (Platform.isDesktopApp) {
			const shots = group("Screenshots");

			slider(shots, "Simulated device width for screenshots", "screenshotWidth", 700, 1920, 64);
			divider(shots);
			slider(shots, "Saved screenshot width in pixels, in the plugin folder", "screenshotSaveWidth", 320, 1920, 64);
			divider(shots);
			new Setting(shots)
				.setName("Hide cookie pop-ups in screenshots, without clicking them")
				.addToggle((toggle) =>
					toggle.setValue(settings.hideCookieBanners).onChange(async (value) => {
						settings.hideCookieBanners = value;
						await commit(false);
					}),
				);
			divider(shots);
			new Setting(shots)
				.setName("Simulated device theme for screenshots")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("light", "Light")
						.addOption("dark", "Dark")
						.setValue(settings.screenshotTheme)
						.onChange(async (value) => {
							settings.screenshotTheme = value as ScreenshotTheme;
							await commit(false);
						}),
				);
			divider(shots);
			const purge = new Setting(shots);
			let purgeButton: ButtonComponent | null = null;
			const syncPurge = (): void => {
				const count = this.plugin.screenshotCount();
				purge.setName(
					count === 0 ? "No saved screenshots" : count === 1 ? "1 saved screenshot" : `${count} saved screenshots`,
				);
				purgeButton?.setDisabled(count === 0);
			};
			purge.addButton((button) => {
				purgeButton = button;
				button.setButtonText("Delete all").onClick(() => {
					const count = this.plugin.screenshotCount();
					if (count === 0) return;
					new ConfirmModal(
						this.app,
						count === 1 ? "Delete the saved screenshot?" : `Delete all ${count} saved screenshots?`,
						["Cards go back to the page image or favicon. This can't be undone, but you can take new screenshots any time."],
						"Delete",
						() => {
							void this.plugin.removeAllScreenshots().then((removed) => {
								syncPurge();
								new Notice(`Deleted ${plural(removed, "screenshot")}.`);
							});
						},
					).open();
				});
				setIcon(button.buttonEl.createSpan({ cls: "wlg-link-icon" }), "trash-2");
			});
			syncPurge();
		}

		const info = group("Information");

		new Setting(info)
			.setName("Preferred title")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("markdown", "Markdown link title")
					.addOption("website", "Original website title")
					.setValue(settings.titleSource)
					.onChange(async (value) => {
						settings.titleSource = value as TitleSource;
						await commit(true);
					}),
			);
		divider(info);
		new Setting(info)
			.setName("Cut off long titles after")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("1", "One line")
					.addOption("2", "Two lines")
					.addOption("0", "Show full title")
					.setValue(String(settings.titleLines))
					.onChange(async (value) => {
						settings.titleLines = Number(value);
						await commit(false);
					}),
			);
		divider(info);
		new Setting(info)
			.setName("Show description")
			.addToggle((toggle) =>
				toggle.setValue(settings.showDescription).onChange(async (value) => {
					settings.showDescription = value;
					await commit(false);
				}),
			);
		divider(info);
		new Setting(info)
			.setName("Show domain")
			.addToggle((toggle) =>
				toggle.setValue(settings.showDomain).onChange(async (value) => {
					settings.showDomain = value;
					await commit(false);
				}),
			);
		divider(info);
		const faviconSetting = new Setting(info).setName("Show favicon");
		const showFaviconSize = (visible: boolean): void => {
			faviconSetting.controlEl.toggleClass("wlg-width-off", !visible);
		};
		faviconSetting
			.addSlider((slider) =>
				slider
					.setLimits(10, 32, 1)
					.setValue(settings.faviconSize)
					.onChange(async (value) => {
						settings.faviconSize = value;
						await commit(false);
					}),
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.showFavicon).onChange(async (value) => {
					settings.showFavicon = value;
					showFaviconSize(value);
					await commit(false);
				}),
			);
		showFaviconSize(settings.showFavicon);
		divider(info);
		new Setting(info)
			.setName("Preload thumbnails before they come into view to prevent pop-in")
			.addToggle((toggle) =>
				toggle.setValue(settings.preloadImages).onChange(async (value) => {
					settings.preloadImages = value;
					await commit(true);
				}),
			);

		const tools = group("Tools");

		const applyExclusions = debounce(
			() => {
				void this.plugin.saveSettings();
				this.plugin.refresh(true);
			},
			800,
			true,
		);
		const exclusions = new Setting(tools).setName("Excluded websites");
		exclusions.settingEl.addClass("wlg-setting-wide");
		exclusions.addText((text) => {
			text
				.setPlaceholder("example.com, another-site.org")
				.setValue(settings.excludedDomains.join(", "))
				.onChange((value) => {
					settings.excludedDomains = parseDomains(value);
					applyExclusions();
				});
		});
		divider(tools);
		new Setting(tools)
			.setName("Automatically add titles to pasted website links")
			.addToggle((toggle) =>
				toggle.setValue(settings.titleOnPaste).onChange(async (value) => {
					settings.titleOnPaste = value;
					await commit(false);
				}),
			);
		divider(tools);
		const toolIcon = (button: ButtonComponent, icon: string): void => {
			setIcon(button.buttonEl.createSpan({ cls: "wlg-link-icon" }), icon);
		};
		new Setting(tools)
			.setName("Add missing titles to website links")
			.addButton((button) => {
				button.setButtonText("Scan notes").onClick(async () => {
					button.setDisabled(true);
					try {
						await this.plugin.offerBareLinkConversion();
					} finally {
						button.setDisabled(false);
					}
				});
				toolIcon(button, "pencil");
			});
		divider(tools);
		new Setting(tools)
			.setName("Clear cached information")
			.addButton((button) => {
				button.setButtonText("Clear cache").onClick(async () => {
					await this.plugin.clearCache();
					new Notice("Cache cleared.");
				});
				toolIcon(button, "trash-2");
			});

		const support = group("Support");

		const email = "contact@kgniewek.com";
		new Setting(support)
			.setName("Contact")
			.setDesc("Found a bug or have a suggestion? Get in touch.")
			.addButton((button) => {
				button.setButtonText(email).onClick(async () => {
					try {
						await navigator.clipboard.writeText(email);
						new Notice(`${email} copied`);
					} catch {
						new Notice(`Could not copy. Email: ${email}`);
					}
				});
				setIcon(button.buttonEl.createSpan({ cls: "wlg-link-icon" }), "copy");
			});
		divider(support);

		const coffee = new Setting(support)
			.setName("Buy me a coffee")
			.setDesc("If you enjoy this plugin, you can support its development.");
		linkButton(coffee, "Buy me a coffee", "https://buymeacoffee.com/kgniewek");

		divider(support);

		new Setting(support)
			.setName("Advanced YouTube Features")
			.setDesc("Turn YouTube links into thumbnail galleries & watch videos in a floating player.")
			.addButton((button) => {
				button.setButtonText("View plugin").onClick(() => {
					window.open("obsidian://show-plugin?id=advanced-youtube-features");
				});
				setIcon(button.buttonEl.createSpan({ cls: "wlg-link-icon" }), "puzzle");
			});

		divider(support);

		new Setting(support)
			.setName("Advanced Daily Tracker")
			.setDesc("Log your activity flexibly & monitor your progress in graphs and heatmaps.")
			.addButton((button) => {
				button.setButtonText("View plugin").onClick(() => {
					window.open("obsidian://show-plugin?id=advanced-daily-tracker");
				});
				setIcon(button.buttonEl.createSpan({ cls: "ytg-link-icon" }), "puzzle");
			});
	}
}
