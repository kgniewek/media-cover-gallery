import {
	App,
	addIcon,
	MarkdownPostProcessorContext,
	MarkdownView,
	Menu,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	debounce,
	moment,
	requestUrl,
	setIcon,
	setTooltip,
} from "obsidian";

type TitleMode = "none" | "below" | "hoverBelow" | "tooltip" | "center";
type ClickAction = "preview" | "image" | "wikipedia" | "youtube" | "google" | "none";
type SortOrder = "written" | "newest" | "oldest" | "title";
type GroupBy = "none" | "genre" | "decade" | "creator";

type Kind = "film" | "tv" | "book" | "game" | "album";

interface MovieInfo {
	kind: Kind;
	qid?: string;
	details?: { genres: string[]; creators: string[] };
	artist?: string;
	page: string;
	lang: string;
	title: string;
	year: string;
	poster: string | null;
	posterHi?: string | null;
	overview: string;
}

interface CacheEntry {
	info: MovieInfo | null;
	at: number;
}

interface Host {
	ctx: MarkdownPostProcessorContext;
	el: HTMLElement;
}

interface Origin extends Host {
	key: string;
	nth: number;
}

interface Entry {
	title: string;
	year: string;
	extra?: string;
	hint?: Kind;
	origin?: Origin;
}

interface MoviePosterSettings {
	enableMedia: boolean;
	enableAlbums: boolean;
	clickAction: ClickAction;
	albumClickAction: ClickAction;
	columns: number;
	marginTop: number;
	marginBottom: number;
	gapHorizontal: number;
	gapVertical: number;
	cornerRadius: number;
	titleSize: number;
	titleMode: TitleMode;
	removeButton: boolean;
	wikiMainLanguage: string;
	wikiLanguage: string;
	imageQuality: number;
	sort: SortOrder;
	groupBy: GroupBy;
	cache: Record<string, CacheEntry>;
}

const DEFAULT_SETTINGS: MoviePosterSettings = {
	enableMedia: true,
	enableAlbums: true,
	clickAction: "preview",
	albumClickAction: "preview",
	columns: 5,
	marginTop: 8,
	marginBottom: 8,
	gapHorizontal: 20,
	gapVertical: 20,
	cornerRadius: 16,
	titleSize: 12,
	titleMode: "tooltip",
	removeButton: false,
	wikiMainLanguage: "en",
	wikiLanguage: "none",
	imageQuality: 3,
	sort: "written",
	groupBy: "none",
	cache: {},
};

const CACHE_PREFIX = "v8|";
const FULL_IMAGE_SIZE = 1400;
const ITUNES_SIZES = [3000, 1400];
const wikiApi = (lang: string): string => `https://${lang}.wikipedia.org/w/api.php`;
const WIKI_AGENT = "MediaCoverGallery/1.0 (contact@kgniewek.com)";
const HIT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MISS_MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_PARALLEL = 4;

interface QualityLevel {
	gallery: number;
	preview: number;
}
const QUALITY_LEVELS: QualityLevel[] = [
	{ gallery: 250, preview: 500 },
	{ gallery: 330, preview: 960 },
	{ gallery: 500, preview: 1280 },
	{ gallery: 960, preview: 1920 },
];
const PLAIN_LINE = /^(.*\S)\s*\((\d{4})(?:\s*,\s*([^)]*))?\)\s*$/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const ALBUM_SPLIT = /\s+[-–—]\s+/;

const KIND_TAGS: Record<Kind, string[]> = {
	film: ["film"],
	tv: ["TV series", "American TV series", "British TV series", "miniseries"],
	book: ["novel", "book"],
	game: ["video game"],
	album: ["album"],
};
const MEDIA_KINDS: Kind[] = ["film", "tv", "book", "game"];
const KIND_WORDS = new Map<string, Kind>([
	["film", "film"],
	["movie", "film"],
	["game", "game"],
	["video game", "game"],
	["videogame", "game"],
	["album", "album"],
	["ep", "album"],
	["tv", "tv"],
	["tv series", "tv"],
	["tv show", "tv"],
	["series", "tv"],
	["show", "tv"],
	["television", "tv"],
	["miniseries", "tv"],
	["book", "book"],
	["novel", "book"],
]);

const FILM_RE = /film|movie|фильм|кино|映画|电影|電影|영화|cine/i;
const GAME_RE = /video ?game|computer game|\bgame\b|\bgra (?:komputerowa|wideo)|videospiel|computerspiel|jeu vidéo|jeu video|videojuego|videogioco|videojogo|jogo eletr|počítačová hra|видеоигр|компьютерн\S* игр|ゲーム/i;
const ALBUM_RE = /album|álbum|альбом|アルバム|\bEP\b|mixtape|extended play/i;
const TV_RE = /television series|tv series|\btv (?:show|program)|miniseries|\bsitcom|web series|телесериал|сериал|serial telewizyjny|serial \(|série télévisée|fernsehserie|serie de televisión|serie televisiva|テレビ|电视剧|電視劇|드라마/i;
const BOOK_RE = /\bnovel(?:la|s)?\b|\bbook\b|\bmemoir\b|powieść|\broman\b|novela|romanzo|小説|小说|роман|книга|kniha/i;
const TITLE_KIND: [RegExp, Kind][] = [
	[/\((?:[^)]*\s)?(?:tv series|television series|miniseries|tv miniseries|web series|tv program)\)\s*$/i, "tv"],
	[/\((?:[^)]*\s)?(?:novel|book|novella|memoir|short story collection|poetry collection)\)\s*$/i, "book"],
	[/\((?:[^)]*\s)?video game\)\s*$/i, "game"],
	[/\((?:[^)]*\s)?film\)\s*$/i, "film"],
	[/\((?:[^)]*\s)?(?:album|ep|soundtrack)\)\s*$/i, "album"],
];

const wikiPageUrl = (page: string, lang = "en"): string => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, "_"))}`;
const wikiSearchUrl = (query: string, lang = "en"): string => `https://${lang}.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
const imdbUrl = (title: string, year: string): string =>
	`https://www.imdb.com/find/?q=${encodeURIComponent(`${title} ${year}`.trim())}&s=tt`;
const youtubeUrl = (query: string): string => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
const searchUrl = (query: string): string => `https://www.google.com/search?q=${encodeURIComponent(query)}`;
const KIND_WORD: Record<Kind, string> = { film: "film", tv: "TV series", book: "book", game: "video game", album: "album" };
const ALL_ACTIONS: ClickAction[] = ["preview", "image", "wikipedia", "youtube", "google", "none"];
const ALBUM_ACTIONS: ClickAction[] = ["preview", "image", "wikipedia", "youtube", "google", "none"];
const sourceUrl = (info: MovieInfo): string => wikiPageUrl(info.page, info.lang);

function sourceKey(raw: string): string {
	return raw.trim().replace(LIST_MARKER, "").trim();
}

function parseExtra(raw: string | undefined): { hint?: Kind; extra?: string } {
	if (!raw) return {};
	let hint: Kind | undefined;
	const rest: string[] = [];
	for (const part of raw.split(",")) {
		const word = part.trim();
		if (!word) continue;
		const kind = KIND_WORDS.get(word.toLowerCase());
		if (kind && !hint) hint = kind;
		else rest.push(word);
	}
	return { hint, extra: rest.join(", ") || undefined };
}

function parseLine(raw: string, yearRequired: boolean, defaultHint?: Kind): Entry | null {
	const line = raw.trim().replace(LIST_MARKER, "").trim();
	if (!line) return null;
	const match = PLAIN_LINE.exec(line);
	if (match) {
		const { hint, extra } = parseExtra(match[3]);
		return { title: match[1].trim(), year: match[2], extra, hint: hint ?? defaultHint };
	}
	return yearRequired ? null : { title: line, year: "", hint: defaultHint };
}

function splitAlbum(title: string): { artist: string; album: string } | null {
	const match = ALBUM_SPLIT.exec(title);
	if (!match) return null;
	const artist = title.slice(0, match.index).trim();
	const album = title.slice(match.index + match[0].length).trim();
	return artist && album ? { artist, album } : null;
}

function classifyPage(page: WikiPage): Kind | null {
	for (const [re, kind] of TITLE_KIND) if (re.test(page.title)) return kind;
	const base = page.title.replace(/\s*\([^)]*\)\s*$/, "");
	const head = (page.extract ?? "").slice(0, 300).replace(base, " ");
	let best: Kind | null = null;
	let bestAt = Infinity;
	const tests: [RegExp, Kind][] = [
		[FILM_RE, "film"],
		[TV_RE, "tv"],
		[BOOK_RE, "book"],
		[GAME_RE, "game"],
		[ALBUM_RE, "album"],
	];
	for (const [re, kind] of tests) {
		const at = head.search(re);
		if (at >= 0 && at < bestAt) {
			best = kind;
			bestAt = at;
		}
	}
	return best;
}

const OTHER = "Other";
const CREATOR_PROPS: Record<Kind, string[]> = { film: ["P57"], tv: ["P170", "P57"], book: ["P50"], game: ["P178"], album: ["P175"] };

const GENRE_RULES: Record<Kind, [string, RegExp][]> = {
	tv: [
		["Animation", /animat|anime|cartoon/i],
		["Documentary", /documentar/i],
		["Reality", /reality|talk show|game show/i],
		["Sci-fi", /science fiction|sci-?fi|cyberpunk/i],
		["Fantasy", /fantasy/i],
		["Horror", /horror/i],
		["Action", /action|superhero/i],
		["Thriller", /thriller|suspense|spy/i],
		["Crime", /crime|police|procedural|gangster/i],
		["Mystery", /mystery|detective/i],
		["War", /\bwar\b|military/i],
		["Western", /western/i],
		["Romance", /romanc/i],
		["Comedy", /comed|sitcom|satire/i],
		["Adventure", /adventure/i],
		["Drama", /drama|soap/i],
	],
	book: [
		["Sci-fi", /science fiction|sci-?fi|dystopi|cyberpunk/i],
		["Fantasy", /fantasy/i],
		["Horror", /horror|gothic/i],
		["Mystery", /mystery|detective|whodunit/i],
		["Thriller", /thriller|suspense|spy/i],
		["Crime", /crime|noir/i],
		["Romance", /romanc/i],
		["Historical", /histor/i],
		["Biography", /biograph|memoir/i],
		["Non-fiction", /non-?fiction|essay|self-help|philosoph|science/i],
		["Young adult", /young adult|coming-of-age|bildungsroman/i],
		["Children's", /child/i],
		["Adventure", /adventure/i],
		["Satire", /satir|humou?r|comed/i],
		["Drama", /drama|literary|psycholog|social/i],
	],
	film: [
		["Animation", /animat|anime/i],
		["Documentary", /documentar/i],
		["Horror", /horror|slasher/i],
		["Sci-fi", /science fiction|sci-?fi|cyberpunk/i],
		["Fantasy", /fantasy/i],
		["Action", /action|martial arts|superhero/i],
		["Thriller", /thriller|suspense|spy/i],
		["Crime", /crime|gangster|heist|noir/i],
		["Mystery", /mystery|detective/i],
		["War", /\bwar\b|military/i],
		["Western", /western/i],
		["Romance", /romanc|romantic/i],
		["Comedy", /comed|satire|parody/i],
		["Musical", /music/i],
		["Biography", /biograph|biopic/i],
		["Adventure", /adventure/i],
		["Family", /family|children/i],
		["Drama", /drama/i],
	],
	game: [
		["Horror", /horror/i],
		["Shooter", /shoot/i],
		["Role-playing", /role-?playing|rpg/i],
		["Fighting", /fighting|beat .?em/i],
		["Racing", /racing|driving/i],
		["Sports", /sport|football|soccer|basketball|golf/i],
		["Platformer", /platform/i],
		["Puzzle", /puzzle/i],
		["Strategy", /strategy|tower defen|4x|tactic/i],
		["Simulation", /simulat|management|sandbox|building/i],
		["Adventure", /adventure|visual novel/i],
		["Action", /action|hack and slash|stealth|survival|roguelike/i],
	],
	album: [
		["Soundtrack", /soundtrack|film score|score/i],
		["Metal", /metal/i],
		["Punk", /punk|hardcore/i],
		["Hip hop", /hip.?hop|\brap\b|trap/i],
		["Electronic", /electro|house|techno|dance|synth|ambient|trance|dubstep|edm/i],
		["Jazz", /jazz/i],
		["Classical", /classical|opera|orchestr/i],
		["Blues", /blues/i],
		["Country", /country/i],
		["Folk", /folk/i],
		["Reggae", /reggae|ska\b/i],
		["R&B / Soul", /r&b|rhythm and blues|soul|funk|disco/i],
		["Indie", /indie|alternative|shoegaze|emo\b/i],
		["Rock", /rock/i],
		["Pop", /pop/i],
	],
};

function tidyGenre(label: string): string {
	const cleaned = label.replace(/\s+(?:film|video game|game|music|genre|album|novel|book|television series|tv series|series|television)$/i, "").trim();
	return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : OTHER;
}

function genreGroup(kind: Kind, genres: string[]): string {
	for (const genre of genres) {
		for (const [name, re] of GENRE_RULES[kind]) if (re.test(genre)) return name;
	}
	return genres[0] ? tidyGenre(genres[0]) : OTHER;
}

function claimIds(claims: NonNullable<WdEntity["claims"]>, props: string[], max: number): string[] {
	const ids: string[] = [];
	for (const prop of props) {
		for (const statement of claims[prop] ?? []) {
			const id = statement.mainsnak?.datavalue?.value?.id;
			if (id && statement.rank !== "deprecated" && !ids.includes(id)) ids.push(id);
		}
	}
	return ids.slice(0, max);
}

function paragraphLines(p: HTMLElement): string[] | null {
	let text = "";
	for (const node of Array.from(p.childNodes)) {
		if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
		else if ((node as HTMLElement).tagName === "BR") text += "\n";
		else return null;
	}
	return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function listLines(ul: HTMLElement): string[] | null {
	const lines: string[] = [];
	for (const li of Array.from(ul.children)) {
		if (li.tagName !== "LI") return null;
		for (const node of Array.from(li.childNodes)) {
			if (node.nodeType !== Node.TEXT_NODE) return null;
		}
		lines.push((li.textContent ?? "").trim());
	}
	return lines;
}

function normalize(text: string): string {
	return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function baseTitle(value: string): string {
	return normalize(value.replace(/\s*\([^)]*\)\s*$/, "")).replace(/^the /, "");
}

function titleVariants(title: string): string[] {
	const list = [title];
	const withoutPart = title.replace(/\s+part\s+(?:i|1)$/i, "");
	if (withoutPart !== title) list.push(withoutPart);
	return list;
}

function sortEntries(entries: Entry[], order: SortOrder): Entry[] {
	if (order === "written") return entries;
	const sorted = [...entries];
	const year = (e: Entry): number => (e.year ? Number(e.year) : order === "newest" ? -1 : 9999);
	if (order === "newest") sorted.sort((a, b) => year(b) - year(a));
	else if (order === "oldest") sorted.sort((a, b) => year(a) - year(b));
	else sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
	return sorted;
}

interface ITunesResult {
	collectionName?: string;
	artistName?: string;
	artworkUrl100?: string;
}

interface WikiPage {
	title: string;
	aliases?: string[];
	missing?: boolean;
	extract?: string;
	thumbnail?: { source: string };
	pageprops?: { wikibase_item?: string };
}

interface WdEntity {
	claims?: Record<string, { rank?: string; mainsnak?: { datavalue?: { value?: { id?: string } } } }[]>;
	labels?: Record<string, { value: string }>;
}

interface Placed {
	entry: Entry;
	info: MovieInfo | null;
}

export default class MoviePosterPlugin extends Plugin {
	settings: MoviePosterSettings = { ...DEFAULT_SETTINGS, cache: {} };

	private persistSoon = debounce(() => void this.saveSettings(), 2000, true);
	private observer: IntersectionObserver | null = null;
	private pending = new WeakMap<Element, () => void>();
	private inflight = new Map<string, Promise<MovieInfo | null | undefined>>();
	private queue: (() => void)[] = [];
	private active = 0;
	private closeLightbox: (() => void) | null = null;
	private labelCache = new Map<string, string>();
	private previewPosters = new Map<string, string | null>();
	private fullImages = new Map<string, string[]>();

	async onload(): Promise<void> {
		addIcon("amp-youtube", `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/></g>`);
		await this.loadSettings();
		this.applyStyle();

		this.addSettingTab(new MoviePosterSettingTab(this.app, this));

		const blocks: [string, Kind | undefined][] = [
			["movies", undefined],
			["tv", "tv"],
			["series", "tv"],
			["shows", "tv"],
			["books", "book"],
			["games", "game"],
			["albums", "album"],
		];
		for (const [name, hint] of blocks) {
			this.registerMarkdownCodeBlockProcessor(name, (source, el, ctx) => {
				if (!(hint === "album" ? this.settings.enableAlbums : this.settings.enableMedia)) {
					el.createEl("pre").setText(source);
					return;
				}
				this.renderLines(el, source.split(/\r?\n/), false, hint, { ctx, el });
			});
		}

		this.registerMarkdownPostProcessor((el, ctx) => this.processSection(el, ctx));

		this.app.workspace.onLayoutReady(() => this.refresh(true));
	}

	onunload(): void {
		this.persistSoon.run();
		this.closeLightbox?.();
		this.observer?.disconnect();
		this.observer = null;
		const body = document.body;
		for (const cls of Array.from(body.classList)) {
			if (cls.startsWith("amp-")) body.classList.remove(cls);
		}
		for (const name of [
			"--amp-columns",
			"--amp-mt",
			"--amp-mb",
			"--amp-hgap",
			"--amp-vgap",
			"--amp-radius",
			"--amp-title-size",
		]) {
			body.style.removeProperty(name);
		}
		document.querySelectorAll(".amp-gallery").forEach((el) => el.remove());
		document.querySelectorAll(".amp-source").forEach((el) => el.classList.remove("amp-source"));
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;

		const next: Record<string, unknown> = { ...DEFAULT_SETTINGS, cache: {} };
		for (const key of Object.keys(DEFAULT_SETTINGS)) {
			if (key !== "cache" && key in data) next[key] = data[key];
		}
		this.settings = next as unknown as MoviePosterSettings;

		if (data.enabled === false && !("enableMedia" in data)) {
			this.settings.enableMedia = false;
			this.settings.enableAlbums = false;
		}
		if (["tmdb", "letterboxd", "imdb"].includes(this.settings.clickAction as string)) this.settings.clickAction = "wikipedia";
		if (!ALL_ACTIONS.includes(this.settings.clickAction)) this.settings.clickAction = "preview";
		if (!("albumClickAction" in data)) this.settings.albumClickAction = this.settings.clickAction;
		if (["letterboxd", "imdb"].includes(this.settings.albumClickAction as string)) this.settings.albumClickAction = "wikipedia";
		if (!ALBUM_ACTIONS.includes(this.settings.albumClickAction)) this.settings.albumClickAction = "preview";
		if ((this.settings.groupBy as string) === "type") this.settings.groupBy = "none";
		if ((this.settings.titleMode as string) === "hover") this.settings.titleMode = "center";
		this.settings.imageQuality = Math.min(4, Math.max(1, Math.round(Number(this.settings.imageQuality) || 3)));

		if (this.settings.wikiLanguage === "auto") {
			const locale = moment.locale().slice(0, 2).toLowerCase();
			this.settings.wikiLanguage = locale && locale !== "en" ? locale : "none";
		}

		const now = Date.now();
		const oldCache = (data.cache ?? {}) as Record<string, CacheEntry>;
		for (const [key, entry] of Object.entries(oldCache)) {
			if (!key.startsWith(CACHE_PREFIX)) continue;
			const age = entry.info ? HIT_MAX_AGE : MISS_MAX_AGE;
			if (now - entry.at >= age) continue;
			this.settings.cache[key] = entry;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	clearCache(): void {
		this.settings.cache = {};
		this.inflight.clear();
		void this.saveSettings();
	}

	cacheSize(): number {
		return Object.keys(this.settings.cache).length;
	}

	applyStyle(): void {
		const s = this.settings;
		const body = document.body;
		for (const cls of Array.from(body.classList)) {
			if (cls.startsWith("amp-")) body.classList.remove(cls);
		}
		body.classList.add(`amp-titles-${s.titleMode}`);
		if (s.removeButton) body.classList.add("amp-remove-on");
		const columns = Math.min(s.columns, Platform.isMobile ? 4 : 8);
		body.style.setProperty("--amp-columns", String(columns));
		body.style.setProperty("--amp-mt", `${s.marginTop}px`);
		body.style.setProperty("--amp-mb", `${s.marginBottom}px`);
		body.style.setProperty("--amp-hgap", `${s.gapHorizontal}px`);
		body.style.setProperty("--amp-vgap", `${s.gapVertical}px`);
		body.style.setProperty("--amp-radius", `${s.cornerRadius}px`);
		body.style.setProperty("--amp-title-size", `${s.titleSize}px`);
	}

	refresh(rerender: boolean): void {
		this.applyStyle();
		if (!rerender) return;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
		});
	}

	private processSection(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		if (!this.settings.enableMedia && !this.settings.enableAlbums) return;
		el.findAll("p, ul").forEach((node) => {
			if (node.hasClass("amp-source") || node.closest(".amp-gallery")) return;
			if (node.tagName === "UL" && node.parentElement?.closest("li")) return;
			const lines = node.tagName === "UL" ? listLines(node) : paragraphLines(node);
			if (!lines || !lines.length) return;
			const matches = lines.filter((line) => {
				const entry = parseLine(line, true);
				return entry !== null && this.allowed(entry);
			}).length;
			if (!matches || matches < lines.length * 0.6) return;
			const holder = createDiv();
			node.after(holder);
			node.addClass("amp-source");
			this.renderLines(holder, lines, true, undefined, { ctx, el });
		});
	}

	private allowed(entry: Entry): boolean {
		const isAlbum = entry.hint ? entry.hint === "album" : splitAlbum(entry.title) !== null;
		return isAlbum ? this.settings.enableAlbums : this.settings.enableMedia;
	}

	private renderLines(parent: HTMLElement, lines: string[], strict: boolean, defaultHint?: Kind, host?: Host): void {
		let run: Entry[] = [];
		const seen = new Map<string, number>();
		const flush = (): void => {
			if (run.length) this.renderGallery(parent, run);
			run = [];
		};
		for (const raw of lines) {
			const line = raw.trim();
			if (!line) continue;
			let entry = strict ? parseLine(line, true) : line.startsWith("#") ? null : parseLine(line, false, defaultHint);
			if (strict && entry && !this.allowed(entry)) entry = null;
			if (entry) {
				if (host) {
					const key = sourceKey(line);
					const nth = seen.get(key) ?? 0;
					seen.set(key, nth + 1);
					entry.origin = { ...host, key, nth };
				}
				run.push(entry);
				continue;
			}
			flush();
			parent.createDiv({ cls: "amp-heading", text: line.replace(/^#+\s*/, "").replace(LIST_MARKER, "") });
		}
		flush();
	}

	private renderGallery(parent: HTMLElement, entries: Entry[]): void {
		const sorted = sortEntries(entries, this.settings.sort);
		if (this.settings.groupBy === "none") {
			const gallery = parent.createDiv({ cls: "amp-gallery" });
			for (const entry of sorted) this.renderItem(gallery, entry);
			return;
		}
		this.renderGrouped(parent, sorted);
	}

	private cached(entry: Entry): MovieInfo | null | undefined {
		return this.settings.cache[this.cacheKey(entry)]?.info;
	}

	private renderGrouped(parent: HTMLElement, entries: Entry[]): void {
		const mode = this.settings.groupBy;
		const wantsDetails = mode === "genre" || mode === "creator";
		const holder = parent.createDiv({ cls: "amp-grouped" });
		let run = 0;

		const build = async (): Promise<void> => {
			const id = ++run;
			const refresh = wantsDetails
				? {
						label: mode === "genre" ? "Refresh genres" : "Refresh creators",
						run: (): void => {
							for (const entry of entries) {
								const info = this.cached(entry);
								if (info) delete info.details;
							}
							void build();
						},
					}
				: undefined;

			const known = entries.map((entry) => this.cached(entry));
			if (known.every((info) => info !== undefined && (info === null || !wantsDetails || !!info.details))) {
				this.fillGroups(holder, entries, known as (MovieInfo | null)[], mode, refresh);
				return;
			}

			holder.empty();
			const status = holder.createDiv({ cls: "amp-status" });
			const gallery = holder.createDiv({ cls: "amp-gallery" });
			for (const entry of entries) this.renderItem(gallery, entry);

			let done = 0;
			const update = (): void => status.setText(`Grouping… ${done}/${entries.length}`);
			update();

			const infos = await Promise.all(
				entries.map(async (entry) => {
					const info = (await this.lookup(entry, false)) ?? null;
					done++;
					update();
					return info;
				}),
			);
			if (wantsDetails) await this.loadDetails(infos.filter((i): i is MovieInfo => i !== null));
			if (id !== run || !holder.isConnected) return;
			this.fillGroups(holder, entries, infos, mode, refresh);
		};

		void build();
	}

	private fillGroups(
		holder: HTMLElement,
		entries: Entry[],
		infos: (MovieInfo | null)[],
		mode: GroupBy,
		refresh?: { label: string; run: () => void },
	): void {
		const groups = new Map<string, Placed[]>();
		entries.forEach((entry, i) => {
			const key = this.groupKey(entry, infos[i], mode);
			const list = groups.get(key);
			if (list) list.push({ entry, info: infos[i] });
			else groups.set(key, [{ entry, info: infos[i] }]);
		});

		holder.empty();
		for (const [name, list] of this.orderGroups(groups, mode)) {
			const heading = holder.createDiv({ cls: "amp-group-heading" });
			heading.createSpan({ text: name });
			heading.createSpan({ cls: "amp-group-count", text: String(list.length) });
			const gallery = holder.createDiv({ cls: "amp-gallery" });
			for (const { entry, info } of list) this.renderItem(gallery, entry, info, refresh);
		}
	}

	private groupKey(entry: Entry, info: MovieInfo | null, mode: GroupBy): string {
		if (mode === "decade") {
			const year = Number(info?.year || entry.year);
			return year ? `${Math.floor(year / 10) * 10}s` : OTHER;
		}
		if (mode === "creator") {
			const found = info?.artist ?? info?.details?.creators[0];
			if (found) return found;
			const kind = info?.kind ?? entry.hint ?? (splitAlbum(entry.title) ? "album" : undefined);
			return (kind === "album" ? splitAlbum(entry.title)?.artist : undefined) ?? OTHER;
		}
		if (!info?.details?.genres.length) return OTHER;
		return genreGroup(info.kind, info.details.genres);
	}

	private orderGroups(groups: Map<string, Placed[]>, mode: GroupBy): [string, Placed[]][] {
		let list = Array.from(groups.entries());
		if (mode === "creator") {
			const keep: [string, Placed[]][] = [];
			const rest: Placed[] = [];
			for (const [name, items] of list) {
				if (name !== OTHER && items.length >= 2) keep.push([name, items]);
				else rest.push(...items);
			}
			if (rest.length) keep.push([OTHER, rest]);
			list = keep;
		}
		const oldestFirst = this.settings.sort === "oldest";
		list.sort(([a, aItems], [b, bItems]) => {
			if (a === OTHER || b === OTHER) return (a === OTHER ? 1 : 0) - (b === OTHER ? 1 : 0);
			if (mode === "decade") return oldestFirst ? parseInt(a, 10) - parseInt(b, 10) : parseInt(b, 10) - parseInt(a, 10);
			return bItems.length - aItems.length || a.localeCompare(b);
		});
		return list;
	}

	private renderItem(gallery: HTMLElement, entry: Entry, preset?: MovieInfo | null, refreshGroups?: { label: string; run: () => void }): void {
		const item = gallery.createDiv({ cls: "amp-item" });
		item.tabIndex = 0;
		item.setAttr("role", "button");
		const label = entry.year ? `${entry.title} (${entry.year})` : entry.title;

		const poster = item.createDiv({ cls: "amp-poster" });
		const placeholder = poster.createDiv({ cls: "amp-placeholder" });
		placeholder.createSpan({ text: entry.title });
		const img = poster.createEl("img");
		img.alt = entry.title;
		img.draggable = false;
		img.addEventListener("load", () => img.addClass("is-loaded"));
		img.addEventListener("error", () => img.removeClass("is-loaded"));
		item.createDiv({ cls: "amp-title", text: label });
		if (this.settings.titleMode === "tooltip") {
			setTooltip(item, label, { placement: "bottom", delay: 0 });
			item.setAttr("data-tooltip-delay", "0");
		}

		if (entry.origin) {
			const remove = item.createEl("button", { cls: "amp-remove" });
			setIcon(remove, "x");
			remove.addEventListener("click", async (event) => {
				event.stopPropagation();
				if (await this.removeEntry(entry)) item.remove();
			});
			remove.addEventListener("keydown", (event) => event.stopPropagation());
		}

		const guessAlbum = entry.hint ? entry.hint === "album" : splitAlbum(entry.title) !== null;
		item.toggleClass("amp-album", guessAlbum);

		let info: MovieInfo | null = null;

		const open = (event: MouseEvent | KeyboardEvent): void => {
			const isAlbum = info ? info.kind === "album" : guessAlbum;
			const action = isAlbum ? this.settings.albumClickAction : this.settings.clickAction;
			if (action === "none") return;
			const modifier = event instanceof MouseEvent && (event.ctrlKey || event.metaKey);
			if (action === "preview" && info && !modifier) {
				event.preventDefault();
				event.stopPropagation();
				this.openPreview(info);
				return;
			}
			if (action === "image" && info && !modifier) {
				event.preventDefault();
				event.stopPropagation();
				this.openImage(info);
				return;
			}
			window.open(this.actionUrl(modifier ? "wikipedia" : action, entry, info), "_blank");
		};
		item.addEventListener("click", open);
		item.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				open(event);
			}
		});

		item.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			const menu = new Menu();
			if (info) {
				const found = info;
				menu.addItem((i) => i.setTitle("Preview").setIcon("info").onClick(() => this.openPreview(found)));
				menu.addItem((i) => i.setTitle("Full image").setIcon("image").onClick(() => this.openImage(found)));
				menu.addItem((i) => i.setTitle("Wikipedia").setIcon("external-link").onClick(() => window.open(sourceUrl(found), "_blank")));
			} else {
				menu.addItem((i) => i.setTitle("Search on Wikipedia").setIcon("search").onClick(() => window.open(wikiSearchUrl(entry.title, this.wikiLanguages()[0]), "_blank")));
			}
			menu.addItem((i) => i.setTitle("Google search").setIcon("search").onClick(() => window.open(this.actionUrl("google", entry, info), "_blank")));
			menu.addItem((i) => i.setTitle("YouTube search").setIcon("amp-youtube").onClick(() => window.open(this.actionUrl("youtube", entry, info), "_blank")));
			menu.addItem((i) =>
				i.setTitle("Copy title").setIcon("copy").onClick(async () => {
					await navigator.clipboard.writeText(entry.title);
					new Notice("Title copied");
				}),
			);
			if (this.settings.groupBy !== "none") {
				menu.addItem((i) =>
					i.setTitle("Fetch again").setIcon("refresh-cw").onClick(() => void load(true)),
				);
			}
			if (refreshGroups) {
				menu.addItem((i) => i.setTitle(refreshGroups.label).setIcon("tags").onClick(() => refreshGroups.run()));
			}
			if (entry.origin) {
				menu.addSeparator();
				menu.addItem((i) =>
					i
						.setTitle("Remove")
						.setIcon("trash-2")
						.setWarning(true)
						.onClick(async () => {
							if (await this.removeEntry(entry)) item.remove();
						}),
				);
			}
			menu.showAtMouseEvent(event);
		});

		const apply = (result: MovieInfo | null): void => {
			info = result;
			if (result?.poster) img.src = result.poster;
			else img.removeAttribute("src");
			item.toggleClass("amp-missing", !result);
			item.toggleClass("amp-album", result ? result.kind === "album" : guessAlbum);
		};

		const load = async (force: boolean): Promise<void> => {
			const result = await this.lookup(entry, force);
			if (result !== undefined) apply(result);
		};

		if (preset !== undefined) apply(preset);
		else this.watch(item, () => void load(false));
	}

	private watch(el: HTMLElement, callback: () => void): void {
		if (!this.observer) {
			this.observer = new IntersectionObserver(
				(records) => {
					for (const record of records) {
						if (!record.isIntersecting) continue;
						this.observer?.unobserve(record.target);
						this.pending.get(record.target)?.();
						this.pending.delete(record.target);
					}
				},
				{ rootMargin: "300px" },
			);
		}
		this.pending.set(el, callback);
		this.observer.observe(el);
	}

	private async removeEntry(entry: Entry): Promise<boolean> {
		const origin = entry.origin;
		const file = origin ? this.app.vault.getAbstractFileByPath(origin.ctx.sourcePath) : null;
		const section = origin?.ctx.getSectionInfo(origin.el);
		if (!origin || !section || !(file instanceof TFile)) {
			new Notice("Can't remove this one from here. Open the note and delete the line instead.");
			return false;
		}

		const removed: { index: number; text: string }[] = [];
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const last = Math.min(section.lineEnd, lines.length - 1);
			let seen = 0;
			for (let i = section.lineStart; i <= last; i++) {
				if (sourceKey(lines[i]) !== origin.key) continue;
				if (seen++ !== origin.nth) continue;
				removed.push({ index: i, text: lines[i] });
				lines.splice(i, 1);
				return lines.join("\n");
			}
			return data;
		});

		if (!removed.length) {
			new Notice("Couldn't find that line in the note.");
			return false;
		}

		const { index, text } = removed[0];
		const notice = new Notice(
			createFragment((fragment) => {
				fragment.createSpan({ text: `Removed ${entry.title}  ` });
				const undo = fragment.createEl("button", { text: "Undo" });
				undo.addEventListener("click", () => {
					notice.hide();
					void this.app.vault.process(file, (data) => {
						const lines = data.split("\n");
						lines.splice(Math.min(index, lines.length), 0, text);
						return lines.join("\n");
					});
				});
			}),
			8000,
		);
		return true;
	}

	private searchTerms(entry: Entry, info: MovieInfo | null): { web: string; video: string } {
		const kind = info?.kind ?? entry.hint ?? (splitAlbum(entry.title) ? "album" : undefined);
		if (kind === "album") {
			const parts = splitAlbum(entry.title);
			const name = info?.artist ? `${info.artist} ${info.title}` : parts ? `${parts.artist} ${parts.album}` : entry.title;
			return { web: `${name} album`, video: name };
		}
		const base = `${info?.title ?? entry.title} ${info?.year || entry.year}`.trim();
		return {
			web: kind ? `${base} ${KIND_WORD[kind]}` : base,
			video: kind === "book" ? `${base} book` : `${base} trailer`,
		};
	}

	private actionUrl(action: ClickAction, entry: Entry, info: MovieInfo | null): string {
		if (action === "google") return searchUrl(this.searchTerms(entry, info).web);
		if (action === "youtube") return youtubeUrl(this.searchTerms(entry, info).video);
		return info ? sourceUrl(info) : wikiSearchUrl(entry.title, this.wikiLanguages()[0]);
	}

	private quality(): QualityLevel {
		const index = Math.min(4, Math.max(1, Math.round(Number(this.settings.imageQuality) || 3)));
		return QUALITY_LEVELS[index - 1];
	}

	private async hiResPoster(info: MovieInfo): Promise<string | null> {
		if (info.posterHi) return info.posterHi;
		const size = this.quality().preview;
		const key = `${info.lang}|${info.page}|${size}`;
		const known = this.previewPosters.get(key);
		if (known !== undefined) return known;
		const pages = await this.wikiQuery(info.lang, { titles: info.page, pithumbsize: String(size) });
		if (pages === undefined) return null;
		const url = pages[0]?.thumbnail?.source ?? null;
		this.previewPosters.set(key, url);
		return url;
	}

	private openPreview(info: MovieInfo): void {
		this.closeLightbox?.();
		const overlay = document.body.createDiv({ cls: "amp-lightbox" });
		const card = overlay.createDiv({ cls: "amp-lightbox-card" });
		const close = card.createEl("button", { cls: "amp-lightbox-close", attr: { "aria-label": "Close" } });
		setIcon(close, "x");

		if (info.poster) {
			const img = card.createEl("img", { cls: "amp-lightbox-poster" });
			img.src = info.poster;
			img.alt = info.title;
			void this.hiResPoster(info).then((url) => {
				if (!url || url === info.poster || !overlay.isConnected) return;
				const sharp = new Image();
				sharp.onload = () => {
					if (overlay.isConnected) img.src = url;
				};
				sharp.src = url;
			});
		}

		const side = card.createDiv({ cls: "amp-lightbox-info" });
		side.createEl("h2", { text: info.title });
		const genre = info.details?.genres.length ? genreGroup(info.kind, info.details.genres) : "";
		const meta = [info.artist ?? info.details?.creators[0], info.year, genre === OTHER ? "" : genre].filter(Boolean).join(" · ");
		if (meta) side.createDiv({ cls: "amp-lightbox-meta", text: meta });
		if (info.overview) side.createEl("p", { cls: "amp-lightbox-overview", text: info.overview });
		const buttons = side.createDiv({ cls: "amp-lightbox-buttons" });
		const entry: Entry = { title: info.title, year: info.year, hint: info.kind };
		const links: [string, string][] = [["Wikipedia", sourceUrl(info)]];
		if (info.kind === "film" || info.kind === "tv") links.push(["IMDb", imdbUrl(info.title, info.year)]);
		links.push(["YouTube", this.actionUrl("youtube", entry, info)], ["Search", this.actionUrl("google", entry, info)]);
		for (const [text, url] of links) {
			const button = buttons.createEl("button", { text });
			setIcon(button.createSpan({ cls: "amp-link-icon" }), "arrow-up-right");
			button.addEventListener("click", () => window.open(url, "_blank"));
		}

		this.bindDismiss(overlay, close);
	}

	private bindDismiss(overlay: HTMLElement, close: HTMLElement): void {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		overlay.setAttr("role", "dialog");
		overlay.setAttr("aria-modal", "true");
		const title = overlay.querySelector("h2, .amp-image-title")?.textContent?.trim();
		overlay.setAttr("aria-label", title || "Preview");
		close.focus();
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				dismiss();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = Array.from(overlay.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])"));
			if (!focusable.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			if (!overlay.contains(active)) {
				event.preventDefault();
				first.focus();
			} else if (event.shiftKey && active === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first.focus();
			}
		};
		const dismiss = (): void => {
			document.removeEventListener("keydown", onKey, true);
			overlay.remove();
			this.closeLightbox = null;
			if (previous?.isConnected) previous.focus();
		};
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) dismiss();
		});
		close.addEventListener("click", dismiss);
		document.addEventListener("keydown", onKey, true);
		this.closeLightbox = dismiss;
	}

	private async fullImage(info: MovieInfo): Promise<string[]> {
		const key = `${info.lang}|${info.page}`;
		const known = this.fullImages.get(key);
		if (known !== undefined) return known;
		let urls: string[] = [];
		if (info.kind === "album") urls = await this.itunesAlbumImages(info);
		if (!urls.length) {
			const pages = await this.wikiQuery(info.lang, { titles: info.page, pithumbsize: String(FULL_IMAGE_SIZE) });
			if (pages === undefined) return [];
			const url = pages[0]?.thumbnail?.source;
			urls = url ? [url] : [];
		}
		this.fullImages.set(key, urls);
		return urls;
	}

	private async itunesAlbumImages(info: MovieInfo): Promise<string[]> {
		const url = new URL("https://itunes.apple.com/search");
		const term = info.artist ? `${info.artist} ${info.title}` : info.title;
		for (const [name, value] of Object.entries({ term, media: "music", entity: "album", limit: "15" })) url.searchParams.set(name, value);
		try {
			const response = await requestUrl({ url: url.toString(), throw: false });
			if (response.status !== 200) return [];
			const results = (response.json as { results?: ITunesResult[] }).results ?? [];
			const wanted = baseTitle(info.title);
			for (const result of results) {
				if (!result.artworkUrl100) continue;
				if (info.artist && baseTitle(result.artistName ?? "") !== baseTitle(info.artist)) continue;
				const name = (result.collectionName ?? "").replace(/\s+-\s+(?:single|ep)$/i, "");
				if (baseTitle(name) !== wanted) continue;
				const art = result.artworkUrl100;
				return ITUNES_SIZES.map((size) => art.replace(/\d+x\d+(?:bb|cc|sr)?(\.\w+)$/, `${size}x${size}bb$1`));
			}
		} catch {
			return [];
		}
		return [];
	}

	private openImage(info: MovieInfo): void {
		if (!info.poster) {
			this.openPreview(info);
			return;
		}
		this.closeLightbox?.();
		const overlay = document.body.createDiv({ cls: "amp-lightbox" });
		const card = overlay.createDiv({ cls: "amp-lightbox-card amp-image-card" });
		const close = card.createEl("button", { cls: "amp-lightbox-close", attr: { "aria-label": "Close" } });
		setIcon(close, "x");
		card.createDiv({ cls: "amp-image-title", text: info.year ? `${info.title} (${info.year})` : info.title });
		const img = card.createEl("img", { cls: "amp-image-full" });
		img.src = info.posterHi ?? info.poster;
		img.alt = info.title;
		card.addEventListener("click", () => this.closeLightbox?.());
		void this.fullImage(info).then((urls) => {
			const tryNext = (index: number): void => {
				if (index >= urls.length || !overlay.isConnected) return;
				const sharp = new Image();
				sharp.onload = () => {
					if (overlay.isConnected) img.src = urls[index];
				};
				sharp.onerror = () => tryNext(index + 1);
				sharp.src = urls[index];
			};
			tryNext(0);
		});
		this.bindDismiss(overlay, close);
	}

	private cacheKey(entry: Entry): string {
		const maybeAlbum = entry.hint === "album" || (!entry.hint && splitAlbum(entry.title) !== null);
		const source = maybeAlbum ? "wikipedia" : "";
		return `${CACHE_PREFIX}q${this.quality().gallery}|${this.wikiLanguages().join("+")}|${source}|${entry.hint ?? ""}|${normalize(entry.title)}|${entry.year}`;
	}

	private async lookup(entry: Entry, force: boolean): Promise<MovieInfo | null | undefined> {
		const key = this.cacheKey(entry);
		const hit = this.settings.cache[key];
		if (!force && hit) return hit.info;

		const running = this.inflight.get(key);
		if (running) return running;

		const task = this.throttle(() => this.searchWikipedia(entry)).then((result) => {
			this.inflight.delete(key);
			if (result !== undefined) {
				this.settings.cache[key] = { info: result, at: Date.now() };
				this.persistSoon();
			}
			return result;
		});
		this.inflight.set(key, task);
		return task;
	}

	private throttle<T>(job: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			const go = (): void => {
				this.active++;
				job()
					.then(resolve, reject)
					.finally(() => {
						this.active--;
						this.queue.shift()?.();
					});
			};
			if (this.active < MAX_PARALLEL) go();
			else this.queue.push(go);
		});
	}

	private async wikidata(params: Record<string, string>): Promise<Record<string, WdEntity> | undefined> {
		const url = new URL("https://www.wikidata.org/w/api.php");
		for (const [name, value] of Object.entries({ action: "wbgetentities", format: "json", ...params })) {
			url.searchParams.set(name, value);
		}
		try {
			const response = await requestUrl({ url: url.toString(), headers: { "Api-User-Agent": WIKI_AGENT }, throw: false });
			if (response.status !== 200) return undefined;
			return (response.json as { entities?: Record<string, WdEntity> }).entities ?? {};
		} catch {
			return undefined;
		}
	}

	private async loadLabels(ids: string[]): Promise<void> {
		const missing = ids.filter((id) => !this.labelCache.has(id));
		for (let n = 0; n < missing.length; n += 50) {
			const entities = await this.wikidata({ ids: missing.slice(n, n + 50).join("|"), props: "labels", languages: "en" });
			if (!entities) continue;
			for (const [id, entity] of Object.entries(entities)) {
				const label = entity.labels?.en?.value;
				if (label) this.labelCache.set(id, label);
			}
		}
	}

	private async loadDetails(infos: MovieInfo[]): Promise<void> {
		const pending = infos.filter((i) => !i.details);
		const linked = pending.filter((i) => i.qid);
		for (const info of pending) if (!info.qid) info.details = { genres: [], creators: [] };

		for (let n = 0; n < linked.length; n += 40) {
			const batch = linked.slice(n, n + 40);
			const entities = await this.wikidata({ ids: batch.map((i) => i.qid as string).join("|"), props: "claims" });
			if (!entities) continue;

			const found = new Map<MovieInfo, { genres: string[]; creators: string[] }>();
			const wanted = new Set<string>();
			for (const info of batch) {
				const claims = entities[info.qid as string]?.claims ?? {};
				const genres = claimIds(claims, ["P136"], 4);
				const creators = claimIds(claims, CREATOR_PROPS[info.kind], 2);
				for (const id of [...genres, ...creators]) wanted.add(id);
				found.set(info, { genres, creators });
			}
			await this.loadLabels(Array.from(wanted));

			const named = (ids: string[]): string[] => ids.map((id) => this.labelCache.get(id)).filter((l): l is string => !!l);
			for (const [info, ids] of found) info.details = { genres: named(ids.genres), creators: named(ids.creators) };
		}
		this.persistSoon();
	}

	private async wikiQuery(lang: string, params: Record<string, string>): Promise<WikiPage[] | undefined> {
		const url = new URL(wikiApi(lang));
		const all: Record<string, string> = {
			action: "query",
			format: "json",
			formatversion: "2",
			redirects: "1",
			prop: "pageimages|extracts|pageprops",
			ppprop: "wikibase_item",
			piprop: "thumbnail",
			pithumbsize: String(this.quality().gallery),
			exintro: "1",
			explaintext: "1",
			exsentences: "3",
			exlimit: "max",
			pilicense: "any",
			...params,
		};
		for (const [name, value] of Object.entries(all)) url.searchParams.set(name, value);
		try {
			const response = await requestUrl({ url: url.toString(), headers: { "Api-User-Agent": WIKI_AGENT }, throw: false });
			if (response.status !== 200) return undefined;
			const query = (
				response.json as {
					query?: {
						pages?: WikiPage[];
						redirects?: { from: string; to: string }[];
						normalized?: { from: string; to: string }[];
					};
				}
			).query;
			const pages = query?.pages ?? [];
			const moves = [...(query?.normalized ?? []), ...(query?.redirects ?? [])];
			for (let round = 0; round < 2; round++) {
				for (const move of moves) {
					for (const page of pages) {
						const names = [page.title, ...(page.aliases ?? [])];
						if (names.includes(move.to) && !names.includes(move.from)) (page.aliases ??= []).push(move.from);
					}
				}
			}
			return pages;
		} catch {
			return undefined;
		}
	}

	private scorePage(page: WikiPage, kinds: Kind[], name: string, year: number, artist?: string): { score: number; kind: Kind } | null {
		if (page.missing || !page.extract) return null;
		const kind = classifyPage(page);
		if (!kind || !kinds.includes(kind)) return null;
		const wanted = titleVariants(name).map((v) => normalize(v).replace(/^the /, ""));
		const names = [page.title, ...(page.aliases ?? [])].map(baseTitle);
		if (!names.some((n) => wanted.includes(n))) return null;
		const text = page.extract;
		if (artist) {
			const who = normalize(artist).replace(/^the /, "");
			if (who && !normalize(`${text} ${page.title}`).includes(who)) return null;
		}
		let score = 40;
		if (year) {
			const near = new RegExp(`\\b(${year - 1}|${year}|${year + 1})\\b`);
			if (!near.test(text) && !near.test(page.title)) score -= 25;
			else score += text.includes(String(year)) || page.title.includes(String(year)) ? 50 : 20;
		}
		if (TITLE_KIND.some(([re]) => re.test(page.title))) score += 30;
		if (page.thumbnail) score += 15;
		return { score, kind };
	}

	private pickPage(pages: WikiPage[], kinds: Kind[], name: string, year: number, artist?: string): { page: WikiPage; kind: Kind } | null {
		let best: { page: WikiPage; kind: Kind } | null = null;
		let bestScore = -1;
		for (const page of pages) {
			const result = this.scorePage(page, kinds, name, year, artist);
			if (result && result.score > bestScore) {
				best = { page, kind: result.kind };
				bestScore = result.score;
			}
		}
		return best;
	}

	wikiLanguages(): string[] {
		const main = this.settings.wikiMainLanguage;
		const second = this.settings.wikiLanguage;
		return second && second !== "none" && second !== main ? [main, second] : [main];
	}

	private async searchWikipedia(entry: Entry): Promise<MovieInfo | null | undefined> {
		let failed = false;
		let fallback: MovieInfo | null = null;
		for (const lang of this.wikiLanguages()) {
			const result = await this.searchWikipediaIn(entry, lang);
			if (result === undefined) {
				failed = true;
				continue;
			}
			if (result?.poster) return result;
			if (result && !fallback) fallback = result;
		}
		if (fallback) return fallback;
		return failed ? undefined : null;
	}

	private async searchWikipediaIn(entry: Entry, lang: string): Promise<MovieInfo | null | undefined> {
		const plan: Kind[][] = entry.hint
			? [[entry.hint]]
			: splitAlbum(entry.title)
				? [["album"], MEDIA_KINDS]
				: [MEDIA_KINDS];
		let failed = false;
		let fallback: MovieInfo | null = null;
		for (const kinds of plan) {
			const result = await this.searchKinds(entry, lang, kinds);
			if (result === undefined) {
				failed = true;
				continue;
			}
			if (result?.poster) return result;
			if (result && !fallback) fallback = result;
		}
		if (fallback) return fallback;
		return failed ? undefined : null;
	}

	private async searchKinds(entry: Entry, lang: string, kinds: Kind[]): Promise<MovieInfo | null | undefined> {
		const albumOnly = kinds.length === 1 && kinds[0] === "album";
		const parts = albumOnly ? splitAlbum(entry.title) : null;
		const name = parts?.album ?? entry.title;
		const artist = parts?.artist;
		const year = Number(entry.year) || 0;

		const candidates = new Set<string>();
		for (const variant of titleVariants(name)) {
			if (artist) candidates.add(`${variant} (${artist} album)`);
			for (const kind of kinds) {
				for (const tag of KIND_TAGS[kind]) {
					if (entry.year) candidates.add(`${variant} (${entry.year} ${tag})`);
					candidates.add(`${variant} (${tag})`);
				}
			}
			candidates.add(variant);
		}

		const direct = await this.wikiQuery(lang, { titles: Array.from(candidates).slice(0, 50).join("|") });
		if (direct === undefined) return undefined;
		let best = this.pickPage(direct, kinds, name, year, artist);

		if (!best || !best.page.thumbnail) {
			const searches = await Promise.all(
				kinds.map((kind) =>
					this.wikiQuery(lang, {
						generator: "search",
						gsrsearch: [name, artist, entry.year, KIND_TAGS[kind][0], entry.extra].filter(Boolean).join(" "),
						gsrlimit: "6",
						gsrnamespace: "0",
					}),
				),
			);
			const seen = new Set(direct.map((p) => p.title));
			const more: WikiPage[] = [];
			let reached = false;
			for (const found of searches) {
				if (found === undefined) continue;
				reached = true;
				for (const page of found) {
					if (seen.has(page.title)) continue;
					seen.add(page.title);
					more.push(page);
				}
			}
			if (reached) best = this.pickPage([...direct, ...more], kinds, name, year, artist);
			else if (!best) return undefined;
		}
		if (!best) return null;

		const { page, kind } = best;
		return {
			kind,
			artist,
			qid: page.pageprops?.wikibase_item,
			page: page.title,
			lang,
			title: page.title.replace(/\s*\([^)]*\)\s*$/, ""),
			year: /\((\d{4}) (?:film|video game|album|novel|book|TV series|miniseries)\)/i.exec(page.title)?.[1] ?? entry.year,
			poster: page.thumbnail?.source ?? null,
			overview: (page.extract ?? "").trim(),
		};
	}
}

class MoviePosterSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: MoviePosterPlugin,
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

		const group = (name: string): HTMLElement => {
			const heading = new Setting(containerEl).setName(name).setHeading();
			heading.settingEl.addClass("amp-settings-section");
			return containerEl.createDiv({ cls: "amp-settings-card" });
		};
		const divider = (card: HTMLElement): void => {
			card.createEl("hr", { cls: "amp-settings-divider" });
		};
		const slider = (
			card: HTMLElement,
			name: string,
			key: "marginTop" | "marginBottom" | "gapHorizontal" | "gapVertical" | "cornerRadius" | "titleSize",
			min: number,
			max: number,
			step: number,
		): void => {
			new Setting(card).setName(name).addSlider((s) =>
				s
					.setLimits(min, max, step)
					.setDynamicTooltip()
					.setValue(settings[key])
					.onChange(async (value) => {
						settings[key] = value;
						await commit(false);
					}),
			);
		};
		const toggle = (card: HTMLElement, name: string, key: "enableMedia" | "enableAlbums" | "removeButton", rerender: boolean): void => {
			new Setting(card).setName(name).addToggle((t) =>
				t.setValue(settings[key]).onChange(async (value) => {
					settings[key] = value;
					await commit(rerender);
				}),
			);
		};
		const linkButton = (setting: Setting, text: string, url: string): void => {
			setting.addButton((button) => {
				button.setButtonText(text).onClick(() => {
					window.open(url, "_blank");
				});
				setIcon(button.buttonEl.createSpan({ cls: "amp-link-icon" }), "arrow-up-right");
			});
		};

		const general = group("Media Cover Gallery");
		new Setting(general)
			.setName("Show movies, books and games as poster galleries")
			.setDesc("Detects one entry per line: Movie Name (2026)")
			.addToggle((t) =>
				t.setValue(settings.enableMedia).onChange(async (value) => {
					settings.enableMedia = value;
					await commit(true);
				}),
			);
		divider(general);
		new Setting(general)
			.setName("Show music albums as cover galleries")
			.setDesc("Detects one entry per line: Artist - Album (2026)")
			.addToggle((t) =>
				t.setValue(settings.enableAlbums).onChange(async (value) => {
					settings.enableAlbums = value;
					await commit(true);
				}),
			);
		divider(general);
		new Setting(general)
			.setName("When clicking a movie, book or game")
			.addDropdown((d) =>
				d
					.addOption("preview", "Show preview")
					.addOption("image", "Show full image")
					.addOption("wikipedia", "Open on Wikipedia")
					.addOption("youtube", "Search on YouTube")
					.addOption("google", "Search on Google")
					.addOption("none", "Do nothing")
					.setValue(settings.clickAction)
					.onChange(async (value) => {
						settings.clickAction = value as ClickAction;
						await commit(false);
					}),
			);
		divider(general);
		new Setting(general).setName("When clicking an album").addDropdown((d) =>
			d
				.addOption("preview", "Show preview")
				.addOption("image", "Show full image")
				.addOption("wikipedia", "Open on Wikipedia")
				.addOption("youtube", "Search on YouTube")
				.addOption("google", "Search on Google")
				.addOption("none", "Do nothing")
				.setValue(settings.albumClickAction)
				.onChange(async (value) => {
					settings.albumClickAction = value as ClickAction;
					await commit(false);
				}),
		);
		divider(general);
		new Setting(general).setName("Sort order").addDropdown((d) =>
			d
				.addOption("written", "As written")
				.addOption("newest", "Newest first")
				.addOption("oldest", "Oldest first")
				.addOption("title", "Title A to Z")
				.setValue(settings.sort)
				.onChange(async (value) => {
					settings.sort = value as SortOrder;
					await commit(true);
				}),
		);
		divider(general);
		new Setting(general)
			.setName("Group covers by")
			.addDropdown((d) =>
				d
					.addOption("none", "Don't group")
					.addOption("genre", "Genre")
					.addOption("decade", "Decade")
					.addOption("creator", "Director / author / artist")
					.setValue(settings.groupBy)
					.onChange(async (value) => {
						settings.groupBy = value as GroupBy;
						await commit(true);
					}),
			);

		const appearance = group("Appearance");
		new Setting(appearance).setName("Covers per row").addDropdown((d) => {
			const max = Platform.isMobile ? 4 : 8;
			for (let i = 2; i <= max; i++) d.addOption(String(i), String(i));
			d.setValue(String(Math.min(settings.columns, max))).onChange(async (value) => {
				settings.columns = Number(value);
				await commit(false);
			});
		});
		divider(appearance);
		new Setting(appearance).setName("Show titles").addDropdown((d) =>
			d
				.addOption("none", "Never")
				.addOption("below", "Always below cover")
				.addOption("hoverBelow", "On hover below cover")
				.addOption("tooltip", "On hover as tooltip")
				.addOption("center", "On hover centered")
				.setValue(settings.titleMode)
				.onChange(async (value) => {
					settings.titleMode = value as TitleMode;
					await commit(true);
				}),
		);
		divider(appearance);
		toggle(appearance, "Show remove button on hover", "removeButton", false);
		divider(appearance);
		slider(appearance, "Title text size", "titleSize", 9, 20, 1);
		divider(appearance);
		slider(appearance, "Corner radius", "cornerRadius", 0, 24, 1);
		divider(appearance);
		slider(appearance, "Space above each gallery", "marginTop", 0, 64, 2);
		divider(appearance);
		slider(appearance, "Space below each gallery", "marginBottom", 0, 64, 2);
		divider(appearance);
		slider(appearance, "Horizontal gap between covers", "gapHorizontal", 0, 48, 2);
		divider(appearance);
		slider(appearance, "Vertical gap between covers", "gapVertical", 0, 64, 2);

		const sources = group("Sources");
		new Setting(sources)
			.setName("Primary language")
			.addDropdown((d) =>
				d
					.addOption("en", "English")
					.addOption("pl", "Polski")
					.addOption("de", "Deutsch")
					.addOption("fr", "Français")
					.addOption("es", "Español")
					.addOption("it", "Italiano")
					.addOption("pt", "Português")
					.addOption("cs", "Čeština")
					.addOption("ru", "Русский")
					.addOption("ja", "日本語")
					.setValue(settings.wikiMainLanguage)
					.onChange(async (value) => {
						settings.wikiMainLanguage = value;
						await commit(true);
					}),
			);
		divider(sources);
		new Setting(sources)
			.setName("Secondary language")
			.addDropdown((d) =>
				d
					.addOption("none", "None")
					.addOption("en", "English")
					.addOption("pl", "Polski")
					.addOption("de", "Deutsch")
					.addOption("fr", "Français")
					.addOption("es", "Español")
					.addOption("it", "Italiano")
					.addOption("pt", "Português")
					.addOption("cs", "Čeština")
					.addOption("ru", "Русский")
					.addOption("ja", "日本語")
					.setValue(settings.wikiLanguage)
					.onChange(async (value) => {
						settings.wikiLanguage = value;
						await commit(true);
					}),
			);

		divider(sources);
		new Setting(sources).setName("Image quality").addDropdown((d) =>
			d
				.addOption("1", "250 px")
				.addOption("2", "330 px")
				.addOption("3", "500 px")
				.addOption("4", "960 px")
				.setValue(String(settings.imageQuality))
				.onChange(async (value) => {
					settings.imageQuality = Number(value);
					await commit(true);
				}),
		);

		divider(sources);
		new Setting(sources)
			.setName("Clear cached information")
			.addButton((button) => {
				button.setButtonText("Clear cache").onClick(() => {
					this.plugin.clearCache();
					this.plugin.refresh(true);
					new Notice("Cache cleared.");
				});
				setIcon(button.buttonEl.createSpan({ cls: "amp-link-icon" }), "trash-2");
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
				setIcon(button.buttonEl.createSpan({ cls: "amp-link-icon" }), "copy");
			});
		divider(support);

		const coffee = new Setting(support)
			.setName("Buy me a coffee")
			.setDesc("If you enjoy this plugin, you can support its development.");
		linkButton(coffee, "Buy me a coffee", "https://buymeacoffee.com/kgniewek");
		divider(support);

		const plugins: [string, string, string][] = [
			["Advanced YouTube Features", "Turn YouTube links into thumbnail galleries & watch videos in a floating player.", "advanced-youtube-features"],
			["Advanced Web Link Features", "Turn website links into preview cards & open sites in a floating window.", "advanced-web-link-features"],
			["Advanced Daily Tracker", "Log your activity flexibly & monitor your progress in graphs and heatmaps.", "advanced-daily-tracker"],
		];
		plugins.forEach(([name, desc, id], index) => {
			if (index > 0) divider(support);
			new Setting(support)
				.setName(name)
				.setDesc(desc)
				.addButton((button) => {
					button.setButtonText("View plugin").onClick(() => {
						window.open(`obsidian://show-plugin?id=${id}`);
					});
					setIcon(button.buttonEl.createSpan({ cls: "amp-link-icon" }), "puzzle");
				});
		});
	}
}
