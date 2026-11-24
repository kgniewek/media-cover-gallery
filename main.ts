import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import {
	App,
	addIcon,
	editorInfoField,
	editorLivePreviewField,
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
type SearchBar = "none" | "left" | "center";

type Rating = "none" | "stars" | "points";

type RatingMode = "always" | "hover";

type TmdbPosters = "off" | "title" | "original" | "textless";

type AlbumCovers = "apple" | "wikipedia";

type CheckMode = "none" | "hover" | "always";

type RemoveMode = "none" | "big" | "small";

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
	artwork?: string;
	overview: string;
	url?: string;
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
	note?: string;
	hint?: Kind;
	blockHint?: Kind;
	origin?: Origin;
	done?: boolean;
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
	groupGap: number;
	cornerRadius: number;
	titleSize: number;
	titleMode: TitleMode;
	removeMode: RemoveMode;
	checkMode: CheckMode;
	rating: Rating;
	ratingMode: RatingMode;
	tmdbPosters: TmdbPosters;
	albumCovers: AlbumCovers;
	tmdbKey: string;
	saveImages: boolean;
	addButton: boolean;
	searchBar: SearchBar;
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
	marginTop: 40,
	marginBottom: 40,
	gapHorizontal: 20,
	gapVertical: 20,
	groupGap: 22,
	cornerRadius: 16,
	titleSize: 12,
	titleMode: "tooltip",
	removeMode: "small",
	checkMode: "none",
	rating: "none",
	ratingMode: "hover",
	tmdbPosters: "off",
	albumCovers: "apple",
	tmdbKey: "",
	saveImages: true,
	addButton: true,
	searchBar: "none",
	wikiMainLanguage: "en",
	wikiLanguage: "none",
	imageQuality: 3,
	sort: "written",
	groupBy: "none",
	cache: {},
};

const CACHE_PREFIX = "v9|";
const FULL_IMAGE_SIZE = 1400;
const ITUNES_SIZES = [3000, 1400];
const appleArt = (art: string, size: number): string => art.replace(/\d+x\d+(?:bb|cc|sr)?(\.\w+)$/, `${size}x${size}bb$1`);
const wikiApi = (lang: string): string => `https://${lang}.wikipedia.org/w/api.php`;
const WIKI_AGENT = "MediaCoverGallery/1.0 (contact@kgniewek.com)";
const HIT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MISS_MAX_AGE = 24 * 60 * 60 * 1000;
const SAVED_MAX_AGE = 365 * 24 * 60 * 60 * 1000;
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
	{ gallery: 700, preview: 1600 },
];
const PLAIN_LINE = /^(.*\S)\s*\((\d{4})(?:\s*,\s*([^)]*))?\)\s*$/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const TASK_MARKER = /^\[([ xX])\]\s+/;
const TASK_LINE = /^(\s*(?:(?:[-*+]|\d+[.)])\s+)?)(?:\[[ xX]\]\s+)?([\s\S]*)$/;
const RATING_RE = /(?:^|\s)(\d+(?:\.\d+)?)\s*\/\s*(5|10)(?=\s|$)/;
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
const sourceUrl = (info: MovieInfo): string => info.url ?? wikiPageUrl(info.page, info.lang);

function sourceKey(raw: string): string {
	return raw.trim().replace(LIST_MARKER, "").replace(TASK_MARKER, "").trim();
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
	const bare = raw.trim().replace(LIST_MARKER, "").trim();
	const task = TASK_MARKER.exec(bare);
	const whole = task ? bare.slice(task[0].length).trim() : bare;
	const done = !!task && task[1] !== " ";
	const pipe = whole.indexOf("|");
	const line = pipe >= 0 ? whole.slice(0, pipe).trim() : whole;
	const note = pipe >= 0 ? whole.slice(pipe + 1).trim() || undefined : undefined;
	if (!line) return null;
	const match = PLAIN_LINE.exec(line);
	if (match) {
		const { hint, extra } = parseExtra(match[3]);
		return { title: match[1].trim(), year: match[2], extra, note, hint: hint ?? defaultHint, done };
	}
	return yearRequired ? null : { title: line, year: "", note, hint: defaultHint, done };
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
		let box: HTMLInputElement | null = null;
		let text = "";
		for (const node of Array.from(li.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE) {
				text += node.textContent ?? "";
				continue;
			}
			const el = node as HTMLElement;
			if (!box && el.tagName === "INPUT" && (el as HTMLInputElement).type === "checkbox") {
				box = el as HTMLInputElement;
				continue;
			}
			return null;
		}
		text = text.trim();
		lines.push(box ? `[${box.checked ? "x" : " "}] ${text}` : text);
	}
	return lines;
}

function parseRating(note?: string): { value: number; max: number } | null {
	const match = note ? RATING_RE.exec(note) : null;
	if (!match) return null;
	const value = Number(match[1]);
	const max = Number(match[2]);
	return value >= 0 && value <= max ? { value, max } : null;
}

function formatRating(rating: { value: number; max: number }): string {
	return rating.max === 5 ? `★ ${rating.value}` : `★ ${rating.value}/10`;
}

function normalize(text: string): string {
	return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function baseTitle(value: string): string {
	return normalize(value.replace(/\s*\([^)]*\)\s*$/, "")).replace(/^the /, "");
}

function creatorNames(extra?: string): string[] {
	return (extra ?? "")
		.split(/,|&|;|\band\b/i)
		.map(normalize)
		.filter((name) => name.length >= 3);
}

function mentionsCreator(page: WikiPage, kind: Kind, creators: string[]): boolean {
	if (!creators.length) return false;
	let text = page.extract ?? "";
	if (kind !== "book") text = text.split(/\b(?:based on|adapted from|inspired by)\b/i)[0];
	const haystack = ` ${normalize(`${text} ${page.title}`)} `;
	return creators.some((name) => haystack.includes(` ${name} `));
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

interface TmdbHit {
	id: number;
	title?: string;
	name?: string;
	original_title?: string;
	original_name?: string;
	release_date?: string;
	first_air_date?: string;
	poster_path?: string | null;
	original_language?: string;
}

interface TmdbImage {
	file_path: string;
	iso_639_1: string | null;
	vote_average: number;
	vote_count: number;
}

interface OpenLibraryDoc {
	key?: string;
	title?: string;
	author_name?: string[];
	first_publish_year?: number;
	cover_i?: number;
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

interface Suggestion {
	line: string;
	title: string;
	year: string;
	kind: Kind;
	thumb: string | null;
}

interface FixCandidate {
	kind: Kind;
	title: string;
	year: string;
	creator?: string;
	page: string;
	qid?: string;
	thumb: string | null;
}

interface WdEntity {
	claims?: Record<string, { rank?: string; mainsnak?: { datavalue?: { value?: { id?: string } } } }[]>;
	labels?: Record<string, { value: string }>;
}

interface Placed {
	entry: Entry;
	info: MovieInfo | null;
}

const refreshLive = StateEffect.define<null>();
const LIVE_FORMATTING = /[*`\[\]<>]|==|~~/;
const LIVE_BREAK = /^(?:#{1,6}\s|>|\||<|\[|:::|%%|\d+[.)]\s|(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$)/;
const LIVE_LIST = /^[-*+]\s+\S/;
const stripTask = (line: string): string => line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]\s+/, "$1");

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
	private tmdbBroken = false;
	private savedSrc = new Map<string, string>();
	private savingPosters = new Set<string>();
	private previewPosters = new Map<string, string | null>();
	private fullImages = new Map<string, string[]>();
	private itemResolvers = new WeakMap<HTMLElement, () => Promise<MovieInfo | null>>();
	private stepping = false;
	private liveVersion = 0;
	private itemNotes = new WeakMap<HTMLElement, string | undefined>();
	private itemSearch = new WeakMap<HTMLElement, () => string>();

	async onload(): Promise<void> {
		addIcon("amp-youtube", `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/></g>`);
		addIcon("amp-gallery-settings", `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><g transform="translate(12 12) scale(0.5)" stroke-width="3"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g></g>`);
		await this.loadSettings();
		this.applyStyle();

		this.addSettingTab(new MoviePosterSettingTab(this.app, this));
		this.addCommand({ id: "open-settings", name: "Open settings", icon: "amp-gallery-settings", callback: () => this.openSettings() });
		this.addRibbonIcon("amp-gallery-settings", "Media Cover Gallery settings", () => this.openSettings());

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

		this.registerEditorExtension(
			StateField.define<DecorationSet>({
				create: (state) => this.liveDecorations(state),
				update: (value, tr) =>
					tr.docChanged || tr.selection || tr.reconfigured || tr.effects.some((effect) => effect.is(refreshLive))
						? this.liveDecorations(tr.state)
						: value,
				provide: (field) => EditorView.decorations.from(field),
			}),
		);
		this.registerEvent(this.app.workspace.on("file-open", () => this.refreshEditors()));

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
			"--amp-group-gap",
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
		if (!["none", "left", "center"].includes(this.settings.searchBar)) this.settings.searchBar = "none";
		if (!["none", "stars", "points"].includes(this.settings.rating)) this.settings.rating = "none";
		if (data.preferTmdb === true && !("tmdbPosters" in data)) this.settings.tmdbPosters = "textless";
		if (!["off", "title", "original", "textless"].includes(this.settings.tmdbPosters)) this.settings.tmdbPosters = "off";
		if (!["apple", "wikipedia"].includes(this.settings.albumCovers)) this.settings.albumCovers = "apple";
		if (!["always", "hover"].includes(this.settings.ratingMode)) this.settings.ratingMode = "hover";
		if ("removeButton" in data && !("removeMode" in data)) this.settings.removeMode = data.removeButton === true ? "big" : "none";
		if (!["none", "big", "small"].includes(this.settings.removeMode)) this.settings.removeMode = "small";
		if (data.checkButton === true && !("checkMode" in data)) this.settings.checkMode = "always";
		if (!["none", "hover", "always"].includes(this.settings.checkMode)) this.settings.checkMode = "none";
		if ((this.settings.titleMode as string) === "hover") this.settings.titleMode = "center";
		this.settings.imageQuality = Math.min(QUALITY_LEVELS.length, Math.max(1, Math.round(Number(this.settings.imageQuality) || 3)));

		if (this.settings.wikiLanguage === "auto") {
			const locale = moment.locale().slice(0, 2).toLowerCase();
			this.settings.wikiLanguage = locale && locale !== "en" ? locale : "none";
		}

		const now = Date.now();
		const oldCache = (data.cache ?? {}) as Record<string, CacheEntry>;
		for (const [key, entry] of Object.entries(oldCache)) {
			if (!key.startsWith(CACHE_PREFIX)) continue;
			const age = entry.info ? (this.settings.saveImages ? SAVED_MAX_AGE : HIT_MAX_AGE) : MISS_MAX_AGE;
			if (now - entry.at >= age) continue;
			this.settings.cache[key] = entry;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private postersDir(): string {
		return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/posters`;
	}

	private posterFile(url: string): string {
		let h1 = 0xdeadbeef;
		let h2 = 0x41c6ce57;
		for (let i = 0; i < url.length; i++) {
			const code = url.charCodeAt(i);
			h1 = Math.imul(h1 ^ code, 2654435761);
			h2 = Math.imul(h2 ^ code, 1597334677);
		}
		h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
		h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
		const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
		const ext = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? "jpg";
		return `${this.postersDir()}/${hash}.${ext}`;
	}

	private async localPoster(url: string): Promise<string | null> {
		const known = this.savedSrc.get(url);
		if (known) return known;
		try {
			const adapter = this.app.vault.adapter;
			const path = this.posterFile(url);
			if (!(await adapter.exists(path))) return null;
			const src = adapter.getResourcePath(path);
			this.savedSrc.set(url, src);
			return src;
		} catch {
			return null;
		}
	}

	private savePoster(url: string): void {
		if (this.savingPosters.has(url)) return;
		this.savingPosters.add(url);
		void this.throttle(async () => {
			try {
				const response = await requestUrl({ url, throw: false });
				if (response.status !== 200 || !response.arrayBuffer.byteLength) return;
				const adapter = this.app.vault.adapter;
				const dir = this.postersDir();
				if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
				const path = this.posterFile(url);
				await adapter.writeBinary(path, response.arrayBuffer);
				this.savedSrc.set(url, adapter.getResourcePath(path));
			} catch {
			}
		}).finally(() => this.savingPosters.delete(url));
	}

	async savedImagesSize(): Promise<{ count: number; bytes: number }> {
		const adapter = this.app.vault.adapter;
		const dir = this.postersDir();
		let count = 0;
		let bytes = 0;
		try {
			if (!(await adapter.exists(dir))) return { count, bytes };
			for (const file of (await adapter.list(dir)).files) {
				count++;
				bytes += (await adapter.stat(file))?.size ?? 0;
			}
		} catch {
		}
		return { count, bytes };
	}

	async clearSavedImages(): Promise<void> {
		this.savedSrc.clear();
		try {
			const dir = this.postersDir();
			if (await this.app.vault.adapter.exists(dir)) await this.app.vault.adapter.rmdir(dir, true);
		} catch {
			new Notice("Media Cover Gallery: could not delete the saved images.");
		}
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
		body.classList.add(`amp-search-${s.searchBar}`);
		if (s.removeMode !== "none") body.classList.add("amp-remove-on");
		if (s.removeMode === "small") body.classList.add("amp-remove-small");
		if (s.checkMode !== "none") body.classList.add("amp-check-on");
		if (s.checkMode === "always") body.classList.add("amp-check-always");
		if (s.rating !== "none" && s.ratingMode === "hover") body.classList.add("amp-rating-hover");
		const columns = Math.min(s.columns, Platform.isMobile ? 4 : 8);
		body.style.setProperty("--amp-columns", String(columns));
		body.style.setProperty("--amp-mt", `${s.marginTop}px`);
		body.style.setProperty("--amp-mb", `${s.marginBottom}px`);
		body.style.setProperty("--amp-hgap", `${s.gapHorizontal}px`);
		body.style.setProperty("--amp-vgap", `${s.gapVertical}px`);
		body.style.setProperty("--amp-group-gap", `${s.groupGap}px`);
		body.style.setProperty("--amp-radius", `${s.cornerRadius}px`);
		body.style.setProperty("--amp-title-size", `${s.titleSize}px`);
	}

	private refreshEditors(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
			cm?.dispatch({ effects: refreshLive.of(null) });
		});
	}

	refresh(rerender: boolean): void {
		this.applyStyle();
		if (!rerender) return;
		this.liveVersion++;
		this.refreshEditors();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
		});
	}

	private liveDecorations(state: EditorState): DecorationSet {
		if (!this.settings.enableMedia && !this.settings.enableAlbums) return Decoration.none;
		if (!state.field(editorLivePreviewField, false)) return Decoration.none;

		const doc = state.doc;
		const builder = new RangeSetBuilder<Decoration>();
		const touches = (from: number, to: number): boolean => state.selection.ranges.some((r) => r.from <= to && r.to >= from);

		let run: { list: boolean; first: number; last: number; lines: string[] } | null = null;
		const flush = (): void => {
			const current = run;
			run = null;
			if (!current || current.lines.some((line) => LIVE_FORMATTING.test(stripTask(line)))) return;
			const matches = current.lines.filter((line) => {
				const entry = parseLine(line, true);
				return entry !== null && this.allowed(entry);
			}).length;
			if (!matches || matches < current.lines.length * 0.6) return;
			const from = doc.line(current.first).from;
			const to = doc.line(current.last).to;
			if (touches(from, to)) return;
			builder.add(from, to, Decoration.replace({ widget: new GalleryWidget(this, current.lines, this.liveVersion), block: true }));
		};

		let fence: string | null = null;
		let math = false;
		let frontmatter = doc.lines > 0 && doc.line(1).text.trim() === "---";
		for (let n = 1; n <= doc.lines; n++) {
			const text = doc.line(n).text;
			const trimmed = text.trim();
			if (frontmatter) {
				if (n > 1 && (trimmed === "---" || trimmed === "...")) frontmatter = false;
				continue;
			}
			const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
			if (fence) {
				if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
				flush();
				continue;
			}
			if (fenceMatch) {
				fence = fenceMatch[1];
				flush();
				continue;
			}
			if (trimmed.startsWith("$$")) {
				if (!(trimmed.length > 2 && trimmed.endsWith("$$"))) math = !math;
				flush();
				continue;
			}
			if (math || !trimmed || /^(?:\t| {4})/.test(text) || LIVE_BREAK.test(trimmed)) {
				flush();
				continue;
			}
			const list = LIVE_LIST.test(text);
			if (run && run.list !== list) flush();
			if (!run) run = { list, first: n, last: n, lines: [] };
			run.last = n;
			run.lines.push(text);
		}
		flush();
		return builder.finish();
	}

	renderLive(view: EditorView, lines: string[]): HTMLElement {
		const wrap = createDiv({ cls: "amp-live" });
		const info = view.state.field(editorInfoField, false);
		const ctx = {
			sourcePath: info?.file?.path ?? "",
			getSectionInfo: () => {
				try {
					const start = view.state.doc.lineAt(view.posAtDOM(wrap)).number - 1;
					return { text: view.state.doc.toString(), lineStart: start, lineEnd: start + lines.length - 1 };
				} catch {
					return null;
				}
			},
		} as unknown as MarkdownPostProcessorContext;

		const edit = wrap.createEl("button", { cls: "amp-live-edit", attr: { "aria-label": "Edit lines" } });
		setIcon(edit, "pencil");
		edit.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
				view.focus();
			} catch {
			}
		});

		this.renderLines(wrap, lines, true, undefined, { ctx, el: wrap });
		return wrap;
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
				if (defaultHint) entry.blockHint = defaultHint;
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
			this.addSearch(gallery, gallery);
			for (const entry of sorted) this.renderItem(gallery, entry);
			const anchor = entries[entries.length - 1];
			if (this.settings.addButton && anchor?.origin) this.renderAddTile(gallery, anchor);
			return;
		}
		this.renderGrouped(parent, sorted, entries[entries.length - 1]);
	}

	private cached(entry: Entry): MovieInfo | null | undefined {
		return this.settings.cache[this.cacheKey(entry)]?.info;
	}

	private renderGrouped(parent: HTMLElement, entries: Entry[], anchor?: Entry): void {
		const mode = this.settings.groupBy;
		const wantsDetails = mode === "genre" || mode === "creator";
		const holder = parent.createDiv({ cls: "amp-grouped" });
		this.addSearch(holder, holder);
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
				this.fillGroups(holder, entries, known as (MovieInfo | null)[], mode, refresh, anchor);
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
			this.fillGroups(holder, entries, infos, mode, refresh, anchor);
		};

		void build();
	}

	private fillGroups(
		holder: HTMLElement,
		entries: Entry[],
		infos: (MovieInfo | null)[],
		mode: GroupBy,
		refresh?: { label: string; run: () => void },
		anchor?: Entry,
	): void {
		const groups = new Map<string, Placed[]>();
		entries.forEach((entry, i) => {
			const key = this.groupKey(entry, infos[i], mode);
			const list = groups.get(key);
			if (list) list.push({ entry, info: infos[i] });
			else groups.set(key, [{ entry, info: infos[i] }]);
		});

		holder.empty();
		let last: HTMLElement | null = null;
		for (const [name, list] of this.orderGroups(groups, mode)) {
			const heading = holder.createDiv({ cls: "amp-group-heading" });
			heading.createSpan({ text: name });
			heading.createSpan({ cls: "amp-group-count", text: String(list.length) });
			const gallery = holder.createDiv({ cls: "amp-gallery" });
			for (const { entry, info } of list) this.renderItem(gallery, entry, info, refresh);
			last = gallery;
		}
		if (last && this.settings.addButton && anchor?.origin) this.renderAddTile(last, anchor);
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

	private addSearch(anchor: HTMLElement, scope: HTMLElement): void {
		if (this.settings.searchBar === "none") return;
		const bar = createDiv({ cls: "amp-search" });
		anchor.before(bar);
		const field = bar.createEl("input", {
			cls: "amp-search-input",
			attr: { type: "text", placeholder: "Filter…", spellcheck: "false", "aria-label": "Filter this gallery" },
		});
		const count = bar.createSpan({ cls: "amp-search-count" });

		const run = (): void => {
			const tokens = normalize(field.value).split(" ").filter(Boolean);
			let shown = 0;
			let total = 0;
			for (const el of Array.from(scope.querySelectorAll<HTMLElement>(".amp-item"))) {
				const text = this.itemSearch.get(el);
				if (!text) {
					el.toggleClass("amp-search-hidden", tokens.length > 0);
					continue;
				}
				total++;
				const haystack = normalize(text());
				const match = tokens.every((token) => haystack.includes(token));
				el.toggleClass("amp-search-hidden", !match);
				if (match) shown++;
			}
			for (const gallery of Array.from(scope.querySelectorAll<HTMLElement>(".amp-gallery"))) {
				const heading = gallery.previousElementSibling;
				if (heading?.hasClass("amp-group-heading")) {
					const any = gallery.querySelector(".amp-item:not(.amp-search-hidden):not(.amp-add)");
					heading.toggleClass("amp-search-hidden", tokens.length > 0 && !any);
				}
			}
			count.setText(tokens.length ? `${shown} / ${total}` : "");
		};

		field.addEventListener("input", run);
		field.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape" && field.value) {
				event.preventDefault();
				field.value = "";
				run();
			}
		});
		field.addEventListener("keyup", (event) => event.stopPropagation());
		new MutationObserver(() => {
			if (field.value.trim()) run();
		}).observe(scope, { childList: true, subtree: true });
	}

	private async saveOpenEditors(file: TFile): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file === file) await leaf.view.save();
		}
	}

	private async addEntryLine(anchor: Entry, line: string): Promise<boolean> {
		const origin = anchor.origin;
		const file = origin ? this.app.vault.getAbstractFileByPath(origin.ctx.sourcePath) : null;
		const section = origin?.ctx.getSectionInfo(origin.el);
		if (!origin || !section || !(file instanceof TFile)) {
			new Notice("Can't add from here. Add the line in the note instead.");
			return false;
		}
		await this.saveOpenEditors(file);

		let added = false;
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const last = Math.min(section.lineEnd, lines.length - 1);
			let seen = 0;
			for (let i = section.lineStart; i <= last; i++) {
				if (sourceKey(lines[i]) !== origin.key) continue;
				if (seen++ !== origin.nth) continue;
				const marker = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(lines[i])?.[0] ?? "";
				lines.splice(i + 1, 0, marker + line);
				added = true;
				return lines.join("\n");
			}
			return data;
		});

		new Notice(added ? `Added ${line}` : "Couldn't find where to add it. Add the line in the note instead.");
		return added;
	}

	private async suggest(query: string, album: boolean): Promise<Suggestion[] | undefined> {
		const lang = this.wikiLanguages()[0];
		const kinds: Kind[] = album ? ["album"] : ["film", "book", "game"];
		const wanted = normalize(query);
		const runs = await Promise.all(
			kinds.map((kind) =>
				this.wikiQuery(lang, {
					generator: "search",
					gsrsearch: `${query} ${KIND_TAGS[kind][0]}`,
					gsrlimit: "6",
					gsrnamespace: "0",
					pithumbsize: "80",
				}),
			),
		);
		if (runs.every((run) => run === undefined)) return undefined;

		const seen = new Set<string>();
		const found: { suggestion: Suggestion; rank: number }[] = [];
		for (const pages of runs) {
			for (const page of pages ?? []) {
				if (seen.has(page.title) || page.missing || !page.extract) continue;
				seen.add(page.title);
				const kind = classifyPage(page);
				if (!kind || !kinds.includes(kind)) continue;
				const year = /\((\d{4})[^)]*\)/.exec(page.title)?.[1] ?? /\b(1[5-9]\d\d|20\d\d)\b/.exec(page.extract)?.[1];
				if (!year) continue;
				const base = page.title.replace(/\s*\([^)]*\)\s*$/, "").replace(/\|/g, " ").trim();
				let line: string;
				if (kind === "album") {
					const artist = /\((.+?)\s+album\)\s*$/i.exec(page.title)?.[1];
					if (!artist) continue;
					line = `${artist} - ${base} (${year})`;
				} else {
					line = kind === "film" ? `${base} (${year})` : `${base} (${year}, ${kind})`;
				}
				const entry = parseLine(line, true);
				if (!entry || !this.allowed(entry)) continue;
				const name = normalize(base);
				const rank = name === wanted ? 0 : name.startsWith(wanted) ? 1 : name.includes(wanted) ? 2 : 3;
				found.push({ suggestion: { line, title: base, year, kind, thumb: page.thumbnail?.source ?? null }, rank });
			}
		}
		found.sort((a, b) => a.rank - b.rank);
		return found.slice(0, 8).map((item) => item.suggestion);
	}

	private async fixCandidates(query: string, entry: Entry): Promise<FixCandidate[] | undefined> {
		const lang = this.wikiLanguages()[0];
		const parts = splitAlbum(query);
		const pool: Kind[] = entry.blockHint ? [entry.blockHint] : entry.hint === "album" ? ["album"] : parts ? ["album", ...MEDIA_KINDS] : MEDIA_KINDS;
		const kinds = pool.filter((kind) => (kind === "album" ? this.settings.enableAlbums : this.settings.enableMedia));
		if (!kinds.length) return [];
		const wanted = normalize(parts?.album ?? query);
		const tidy = (text: string): string => text.replace(/[(),|]/g, " ").replace(/\s+/g, " ").trim();

		const runs = await Promise.all(
			kinds.map((kind) =>
				this.wikiQuery(lang, {
					generator: "search",
					gsrsearch: `${kind === "album" ? query.replace(ALBUM_SPLIT, " ") : query} ${KIND_TAGS[kind][0]}`,
					gsrlimit: "6",
					gsrnamespace: "0",
					pithumbsize: "80",
				}),
			),
		);
		if (runs.every((run) => run === undefined)) return undefined;

		const seen = new Set<string>();
		const found: { candidate: FixCandidate; rank: number }[] = [];
		for (const pages of runs) {
			for (const page of pages ?? []) {
				if (seen.has(page.title) || page.missing || !page.extract) continue;
				seen.add(page.title);
				const kind = classifyPage(page);
				if (!kind || !kinds.includes(kind)) continue;
				const year = /\((\d{4})[^)]*\)/.exec(page.title)?.[1] ?? /\b(1[5-9]\d\d|20\d\d)\b/.exec(page.extract)?.[1];
				if (!year) continue;
				const title = tidy(page.title.replace(/\s*\([^)]*\)\s*$/, ""));
				if (!title) continue;
				let creator: string | undefined;
				if (kind === "album") {
					const artist = /\((.+?)\s+album\)\s*$/i.exec(page.title)?.[1];
					creator = artist && !/^\d{4}$/.test(artist) ? tidy(artist) : undefined;
				}
				const name = normalize(title);
				const rank = name === wanted ? 0 : name.startsWith(wanted) ? 1 : name.includes(wanted) ? 2 : 3;
				found.push({
					candidate: { kind, title, year, creator, page: page.title, qid: page.pageprops?.wikibase_item, thumb: page.thumbnail?.source ?? null },
					rank,
				});
			}
		}
		found.sort((a, b) => a.rank - b.rank);
		const top = found.slice(0, 8).map((item) => item.candidate);

		const infos: MovieInfo[] = top.map((c) => ({ kind: c.kind, qid: c.qid, page: c.page, lang, title: c.title, year: c.year, poster: c.thumb, overview: "" }));
		await this.loadDetails(infos);
		top.forEach((candidate, i) => {
			const first = infos[i].details?.creators[0];
			if (first && !candidate.creator) candidate.creator = tidy(first);
		});
		return top.filter((c) => c.kind !== "album" || !!c.creator);
	}

	private async fixLine(candidate: FixCandidate, entry: Entry): Promise<string> {
		if (candidate.kind === "album") return `${candidate.creator} - ${candidate.title} (${candidate.year})`;
		const word = candidate.kind;
		const head = `${candidate.title} (${candidate.year}`;
		const tries = [`${head})`];
		if (candidate.creator) tries.push(`${head}, ${candidate.creator})`);
		if (entry.blockHint !== candidate.kind) {
			tries.push(`${head}, ${word})`);
			if (candidate.creator) tries.push(`${head}, ${candidate.creator}, ${word})`);
		}
		for (const line of tries) {
			const parsed = parseLine(line, true);
			if (!parsed) continue;
			parsed.hint ??= entry.blockHint;
			const result = await this.throttle(() => this.searchWikipedia(parsed));
			if (result && (result.page === candidate.page || (!!candidate.qid && result.qid === candidate.qid))) return line;
		}
		return tries[tries.length - 1];
	}

	private async applyFix(entry: Entry, line: string): Promise<boolean> {
		const ok = await this.editLine(entry, (raw) => {
			const lead = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/.exec(raw)?.[0] ?? "";
			const pipe = raw.indexOf("|");
			return `${lead}${line}${pipe >= 0 ? ` ${raw.slice(pipe).trim()}` : ""}`;
		});
		if (!ok) return false;
		const parsed = parseLine(line, true);
		if (parsed) {
			entry.title = parsed.title;
			entry.year = parsed.year;
			entry.extra = parsed.extra;
			entry.hint = parsed.hint ?? entry.blockHint;
		}
		return true;
	}

	private openFix(item: HTMLElement, poster: HTMLElement, entry: Entry, current: MovieInfo | null, apply: (line: string) => Promise<void>): void {
		if (item.hasClass("is-fixing")) return;
		item.addClass("is-fixing");
		const written = (entry.origin?.key ?? "").split("|")[0].trim() || entry.title;
		const overlay = poster.createDiv({ cls: "amp-fix" });
		const field = overlay.createEl("input", {
			cls: "amp-fix-input",
			attr: { type: "text", placeholder: "Search…", spellcheck: "false", "aria-label": "Search for the right match" },
		});
		field.value = written;

		let box: HTMLElement | null = null;
		let results: FixCandidate[] = [];
		let selected = 0;
		let token = 0;
		let busy = false;
		let timer: number | undefined;

		const close = (): void => {
			token++;
			window.clearTimeout(timer);
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
			box?.remove();
			box = null;
			overlay.remove();
			item.removeClass("is-fixing");
		};

		const place = (): void => {
			if (!box) return;
			if (!item.isConnected) {
				close();
				return;
			}
			const rect = item.getBoundingClientRect();
			const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8));
			const room = window.innerHeight - rect.bottom;
			const above = room < Math.min(box.offsetHeight, 220) && rect.top > room;
			box.style.left = `${left}px`;
			box.style.top = `${above ? Math.max(8, rect.top - box.offsetHeight - 6) : rect.bottom + 6}px`;
		};

		const choose = async (candidate: FixCandidate): Promise<void> => {
			if (busy) return;
			busy = true;
			token++;
			window.clearTimeout(timer);
			box?.remove();
			box = null;
			field.value = "";
			field.disabled = true;
			field.placeholder = "Updating…";
			try {
				await apply(await this.fixLine(candidate, entry));
			} finally {
				close();
			}
		};

		const paint = (status?: string): void => {
			if (busy) return;
			const shown: HTMLElement = box ?? document.body.createDiv({ cls: "amp-suggest" });
			if (!box) {
				box = shown;
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
			}
			shown.empty();
			shown.setAttr("role", "listbox");
			results.forEach((candidate, index) => {
				const row = shown.createDiv({ cls: `amp-suggest-row${index === selected ? " is-selected" : ""}` });
				row.setAttr("role", "option");
				const thumb = row.createDiv({ cls: "amp-suggest-thumb" });
				if (candidate.thumb) thumb.createEl("img", { attr: { src: candidate.thumb, alt: "" } });
				const text = row.createDiv({ cls: "amp-suggest-text" });
				const line = candidate.kind === "album" ? `${candidate.creator} - ${candidate.title} (${candidate.year})` : `${candidate.title} (${candidate.year})`;
				text.createDiv({ cls: "amp-suggest-title", text: line });
				const name = KIND_WORD[candidate.kind];
				const isCurrent = !!current && (current.page === candidate.page || (!!candidate.qid && current.qid === candidate.qid));
				const meta = [name.charAt(0).toUpperCase() + name.slice(1), candidate.kind === "album" ? undefined : candidate.creator, isCurrent ? "Current" : undefined];
				text.createDiv({ cls: "amp-suggest-meta", text: meta.filter(Boolean).join(" · ") });
				row.addEventListener("mousedown", (event) => {
					event.preventDefault();
					event.stopPropagation();
					void choose(candidate);
				});
			});
			if (status) shown.createDiv({ cls: "amp-suggest-status", text: status });
			place();
			shown.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
		};

		const search = (query: string): void => {
			const mine = ++token;
			void this.fixCandidates(query, entry).then((found) => {
				if (mine !== token || busy || !overlay.isConnected) return;
				results = found ?? [];
				selected = 0;
				paint(found === undefined ? "Couldn't reach Wikipedia" : results.length ? undefined : "No matches. Try a different title.");
			});
		};

		for (const type of ["click", "dblclick", "contextmenu"]) overlay.addEventListener(type, (event) => event.stopPropagation());

		field.addEventListener("input", () => {
			window.clearTimeout(timer);
			const text = field.value.trim();
			const query = PLAIN_LINE.exec(text)?.[1].trim() ?? text;
			if (query.length === 1) return;
			timer = window.setTimeout(() => search(query || entry.title), query ? 250 : 0);
		});

		field.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				item.focus();
			} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				if (!results.length) return;
				event.preventDefault();
				selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
				paint();
			} else if (event.key === "Enter") {
				event.preventDefault();
				if (results.length) void choose(results[selected]);
			}
		});
		field.addEventListener("keyup", (event) => event.stopPropagation());
		field.addEventListener("blur", () => {
			window.setTimeout(() => {
				if (!busy && document.activeElement !== field) close();
			}, 150);
		});

		field.focus();
		field.setSelectionRange(field.value.length, field.value.length);
		paint("Searching…");
		search(entry.title);
	}

	private renderAddTile(gallery: HTMLElement, anchor: Entry): void {
		const isAlbum = anchor.hint ? anchor.hint === "album" : splitAlbum(anchor.title) !== null;
		const tile = gallery.createDiv({ cls: `amp-item amp-add${isAlbum ? " amp-album" : ""}` });
		tile.tabIndex = 0;
		tile.setAttr("role", "button");
		tile.setAttr("aria-label", "Add entry");
		const poster = tile.createDiv({ cls: "amp-poster" });
		const plus = poster.createDiv({ cls: "amp-add-plus" });
		setIcon(plus, "plus");

		let input: HTMLInputElement | null = null;
		let box: HTMLElement | null = null;
		let results: Suggestion[] = [];
		let selected = 0;
		let token = 0;
		let timer: number | undefined;

		const place = (): void => {
			if (!box) return;
			const rect = tile.getBoundingClientRect();
			const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8));
			const room = window.innerHeight - rect.bottom;
			const above = room < Math.min(box.offsetHeight, 220) && rect.top > room;
			box.style.left = `${left}px`;
			box.style.top = `${above ? Math.max(8, rect.top - box.offsetHeight - 6) : rect.bottom + 6}px`;
		};

		const close = (): void => {
			token++;
			window.clearTimeout(timer);
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
			box?.remove();
			box = null;
			input?.remove();
			input = null;
			results = [];
			plus.removeClass("amp-hidden");
			tile.removeClass("is-active");
		};

		const choose = (line: string): void => {
			close();
			void this.addEntryLine(anchor, line);
		};

		const paint = (status?: string): void => {
			if (!input) return;
			const shown: HTMLElement = box ?? document.body.createDiv({ cls: "amp-suggest" });
			if (!box) {
				box = shown;
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
			}
			shown.empty();
			shown.setAttr("role", "listbox");
			results.forEach((result, index) => {
				const row = shown.createDiv({ cls: `amp-suggest-row${index === selected ? " is-selected" : ""}` });
				const thumb = row.createDiv({ cls: "amp-suggest-thumb" });
				if (result.thumb) thumb.createEl("img", { attr: { src: result.thumb, alt: "" } });
				const text = row.createDiv({ cls: "amp-suggest-text" });
				text.createDiv({ cls: "amp-suggest-title", text: result.line });
				text.createDiv({ cls: "amp-suggest-meta", text: KIND_WORD[result.kind] });
				row.addEventListener("mousedown", (event) => {
					event.preventDefault();
					event.stopPropagation();
					choose(result.line);
				});
			});
			if (status) shown.createDiv({ cls: "amp-suggest-status", text: status });
			place();
		};

		const open = (): void => {
			if (input) return;
			tile.addClass("is-active");
			plus.addClass("amp-hidden");
			const field = poster.createEl("input", {
				cls: "amp-add-input",
				attr: { type: "text", placeholder: isAlbum ? "Artist - Album" : "Title…", spellcheck: "false", "aria-label": "Search to add" },
			});
			input = field;
			field.focus();

			field.addEventListener("input", () => {
				window.clearTimeout(timer);
				const query = field.value.trim();
				const mine = ++token;
				if (query.length < 2) {
					results = [];
					box?.remove();
					box = null;
					return;
				}
				timer = window.setTimeout(() => {
					void this.suggest(query, isAlbum).then((found) => {
						if (mine !== token || !input) return;
						results = found ?? [];
						selected = 0;
						paint(found === undefined ? "Couldn't reach Wikipedia" : results.length ? undefined : "No matches. Press Enter to add exactly what you typed.");
					});
				}, 250);
			});

			field.addEventListener("keydown", (event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					close();
					tile.focus();
				} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					if (!results.length) return;
					event.preventDefault();
					selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
					paint();
				} else if (event.key === "Enter") {
					event.preventDefault();
					if (results.length) {
						choose(results[selected].line);
						return;
					}
					const typed = field.value.trim();
					const parsed = parseLine(typed, true);
					if (parsed && this.allowed(parsed)) choose(typed);
					else new Notice("Pick a suggestion, or write it as Title (Year).");
				}
			});
			field.addEventListener("keyup", (event) => event.stopPropagation());
			field.addEventListener("blur", () => {
				window.setTimeout(() => {
					if (input === field && document.activeElement !== field) close();
				}, 150);
			});
		};

		tile.addEventListener("click", (event) => {
			event.stopPropagation();
			open();
		});
		tile.addEventListener("keydown", (event) => {
			if (event.target !== tile || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			open();
		});
	}

	private renderItem(gallery: HTMLElement, entry: Entry, preset?: MovieInfo | null, refreshGroups?: { label: string; run: () => void }): void {
		const item = gallery.createDiv({ cls: "amp-item" });
		item.tabIndex = 0;
		item.setAttr("role", "button");
		let label = entry.year ? `${entry.title} (${entry.year})` : entry.title;

		const poster = item.createDiv({ cls: "amp-poster" });
		const placeholder = poster.createDiv({ cls: "amp-placeholder" });
		const placeholderText = placeholder.createSpan({ text: entry.title });
		const img = poster.createEl("img");
		img.alt = entry.title;
		img.draggable = false;
		img.addEventListener("load", () => img.addClass("is-loaded"));
		img.addEventListener("error", () => img.removeClass("is-loaded"));
		this.itemNotes.set(item, entry.note);
		const shown = entry.note ? `${label} | ${entry.note}` : label;
		const title = item.createDiv({ cls: "amp-title", text: label });
		if (entry.note) {
			const note = title.createSpan({ cls: "amp-note" });
			note.createSpan({ cls: "amp-note-sep", text: " | " });
			note.appendText(entry.note);
		}
		if (this.settings.titleMode === "tooltip") {
			setTooltip(item, shown, { placement: "bottom", delay: 0 });
			item.setAttr("data-tooltip-delay", "0");
		}

		let badge: HTMLElement | null = null;
		const showRating = (): void => {
			badge?.remove();
			badge = null;
			const rating = this.settings.rating !== "none" ? parseRating(entry.note) : null;
			if (rating) badge = item.createDiv({ cls: "amp-rating", text: formatRating(rating) });
		};
		showRating();

		const retitle = (): void => {
			label = entry.year ? `${entry.title} (${entry.year})` : entry.title;
			placeholderText.setText(entry.title);
			img.alt = entry.title;
			const first = title.firstChild;
			if (first && first.nodeType === Node.TEXT_NODE) (first as Text).data = label;
			else title.prepend(label);
			if (this.settings.titleMode === "tooltip") setTooltip(item, entry.note ? `${label} | ${entry.note}` : label, { placement: "bottom", delay: 0 });
		};

		if (entry.origin) {
			const remove = item.createEl("button", { cls: "amp-remove" });
			setIcon(remove, "x");
			remove.addEventListener("click", async (event) => {
				event.stopPropagation();
				if (await this.removeEntry(entry)) item.remove();
			});
			remove.addEventListener("keydown", (event) => event.stopPropagation());

			const check = item.createEl("button", { cls: "amp-check", attr: { "aria-pressed": String(!!entry.done) } });
			setIcon(check, "check");
			item.toggleClass("amp-done", !!entry.done);
			const checkTip = (done: boolean): void => setTooltip(check, done ? "Unmark" : "Mark", { placement: "top", delay: 0 });
			checkTip(!!entry.done);
			check.addEventListener("click", async (event) => {
				event.stopPropagation();
				const next = !item.hasClass("amp-done");
				if (await this.setDone(entry, next)) {
					item.toggleClass("amp-done", next);
					check.setAttr("aria-pressed", String(next));
					checkTip(next);
				}
			});
			check.addEventListener("keydown", (event) => event.stopPropagation());
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
				this.openPreview(info, item);
				return;
			}
			if (action === "image" && info && !modifier) {
				event.preventDefault();
				event.stopPropagation();
				this.openImage(info, item);
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
				menu.addItem((i) => i.setTitle("Preview").setIcon("info").onClick(() => this.openPreview(found, item)));
				menu.addItem((i) => i.setTitle("Full image").setIcon("image").onClick(() => this.openImage(found, item)));
				menu.addItem((i) => i.setTitle(found.url ? "Open Library" : "Wikipedia").setIcon("external-link").onClick(() => window.open(sourceUrl(found), "_blank")));
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
			if (entry.origin) {
				menu.addItem((i) =>
					i
						.setTitle("Change match…")
						.setIcon("search")
						.onClick(() =>
							this.openFix(item, poster, entry, info, async (line) => {
								if (!(await this.applyFix(entry, line))) return;
								retitle();
								new Notice(`Changed to ${line}`);
								await load(true);
							}),
						),
				);
			}
			if (refreshGroups) {
				menu.addItem((i) => i.setTitle(refreshGroups.label).setIcon("tags").onClick(() => refreshGroups.run()));
			}
			if (entry.origin && this.settings.rating !== "none") {
				const stars = this.settings.rating === "stars";
				const max = stars ? 5 : 10;
				const rate = async (value: number | null): Promise<void> => {
					if (!(await this.setRating(entry, value, max))) return;
					this.itemNotes.set(item, entry.note);
					showRating();
				};
				const choose = (target: Menu): void => {
					for (let n = 1; n <= max; n++) {
						target.addItem((i) => i.setTitle(stars ? "★".repeat(n) + "☆".repeat(5 - n) : `${n}/10`).onClick(() => void rate(n)));
					}
					target.addSeparator();
					target.addItem((i) => i.setTitle("Clear rating").setIcon("x").onClick(() => void rate(null)));
				};
				menu.addItem((i) => {
					i.setTitle("Rating").setIcon("star");
					const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
					if (sub) choose(sub);
					else
						i.onClick(() => {
							const picker = new Menu();
							choose(picker);
							picker.showAtMouseEvent(event);
						});
				});
			}
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Settings").setIcon("settings").onClick(() => this.openSettings()));
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
			const poster = result?.poster;
			if (!poster) img.removeAttribute("src");
			else if (!this.settings.saveImages) img.src = poster;
			else {
				const known = this.savedSrc.get(poster);
				if (known) img.src = known;
				else
					void this.localPoster(poster).then((local) => {
						if (info !== result) return;
						img.src = local ?? poster;
						if (!local) this.savePoster(poster);
					});
			}
			item.toggleClass("amp-missing", !result);
			item.toggleClass("amp-album", result ? result.kind === "album" : guessAlbum);
		};

		const load = async (force: boolean): Promise<void> => {
			const result = await this.lookup(entry, force);
			if (result !== undefined) apply(result);
		};

		this.itemSearch.set(item, () =>
			[entry.title, entry.year, entry.note, info?.title, info?.artist, ...(info?.details?.genres ?? []), ...(info?.details?.creators ?? [])]
				.filter(Boolean)
				.join(" "),
		);
		this.itemResolvers.set(item, async () => {
			if (!info) await load(false);
			return info;
		});

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

	private async editLine(entry: Entry, change: (line: string) => string): Promise<boolean> {
		const origin = entry.origin;
		const file = origin ? this.app.vault.getAbstractFileByPath(origin.ctx.sourcePath) : null;
		const section = origin?.ctx.getSectionInfo(origin.el);
		if (!origin || !section || !(file instanceof TFile)) {
			new Notice("Can't change this one from here. Open the note and edit the line instead.");
			return false;
		}

		await this.saveOpenEditors(file);

		const result: { line?: string } = {};
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const last = Math.min(section.lineEnd, lines.length - 1);
			let seen = 0;
			for (let i = section.lineStart; i <= last; i++) {
				if (sourceKey(lines[i]) !== origin.key) continue;
				if (seen++ !== origin.nth) continue;
				lines[i] = change(lines[i]);
				result.line = lines[i];
				return lines.join("\n");
			}
			return data;
		});

		if (result.line === undefined) {
			new Notice("Couldn't find that line in the note.");
			return false;
		}
		origin.key = sourceKey(result.line);
		return true;
	}

	private async setDone(entry: Entry, done: boolean): Promise<boolean> {
		const ok = await this.editLine(entry, (line) => {
			const match = TASK_LINE.exec(line);
			return match ? (done ? `${match[1]}[x] ${match[2]}` : `${match[1]}${match[2]}`) : line;
		});
		if (ok) entry.done = done;
		return ok;
	}

	private async setRating(entry: Entry, value: number | null, max: number): Promise<boolean> {
		let note: string | undefined = entry.note;
		const ok = await this.editLine(entry, (line) => {
			const pipe = line.indexOf("|");
			const head = (pipe >= 0 ? line.slice(0, pipe) : line).trimEnd();
			const text = pipe >= 0 ? line.slice(pipe + 1).trim() : "";
			const rest = text.replace(RATING_RE, " ").replace(/\s+/g, " ").trim();
			const combined = [value === null ? "" : `${value}/${max}`, rest].filter(Boolean).join(" ");
			note = combined || undefined;
			return combined ? `${head} | ${combined}` : head;
		});
		if (ok) entry.note = note;
		return ok;
	}

	private async removeEntry(entry: Entry): Promise<boolean> {
		const origin = entry.origin;
		const file = origin ? this.app.vault.getAbstractFileByPath(origin.ctx.sourcePath) : null;
		const section = origin?.ctx.getSectionInfo(origin.el);
		if (!origin || !section || !(file instanceof TFile)) {
			new Notice("Can't remove this one from here. Open the note and delete the line instead.");
			return false;
		}

		await this.saveOpenEditors(file);

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
			video: kind === "book" ? `${base} book` : base,
		};
	}

	private actionUrl(action: ClickAction, entry: Entry, info: MovieInfo | null): string {
		if (action === "google") return searchUrl(this.searchTerms(entry, info).web);
		if (action === "youtube") return youtubeUrl(this.searchTerms(entry, info).video);
		return info ? sourceUrl(info) : wikiSearchUrl(entry.title, this.wikiLanguages()[0]);
	}

	private quality(): QualityLevel {
		const index = Math.min(QUALITY_LEVELS.length, Math.max(1, Math.round(Number(this.settings.imageQuality) || 3)));
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

	private async stepLightbox(source: HTMLElement, direction: 1 | -1, mode: "preview" | "image"): Promise<void> {
		if (this.stepping) return;
		const items = this.previewItems(source);
		this.stepping = true;
		try {
			for (let i = items.indexOf(source) + direction; i >= 0 && i < items.length; i += direction) {
				const next = items[i];
				const found = await this.itemResolvers.get(next)?.();
				if (!found || (mode === "image" && !found.poster)) continue;
				next.scrollIntoView({ block: "nearest" });
				if (mode === "image") this.openImage(found, next);
				else this.openPreview(found, next);
				return;
			}
		} finally {
			this.stepping = false;
		}
	}

	private lightboxNav(card: HTMLElement, source: HTMLElement, mode: "preview" | "image"): (direction: 1 | -1) => void {
		const items = this.previewItems(source);
		const at = items.indexOf(source);
		const nav = (direction: 1 | -1): void => void this.stepLightbox(source, direction, mode);
		const arrow = (direction: 1 | -1, icon: string, label: string): void => {
			const button = card.createEl("button", {
				cls: `amp-lightbox-nav ${direction === 1 ? "amp-next" : "amp-prev"}`,
				attr: { "aria-label": label },
			});
			setIcon(button, icon);
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				nav(direction);
			});
		};
		if (at > 0) arrow(-1, "chevron-left", "Previous");
		if (at >= 0 && at < items.length - 1) arrow(1, "chevron-right", "Next");
		return nav;
	}

	private previewItems(source: HTMLElement): HTMLElement[] {
		const root = source.closest(".markdown-preview-sizer") ?? source.closest(".amp-gallery");
		return root ? Array.from(root.querySelectorAll<HTMLElement>(".amp-item")) : [source];
	}

	private openPreview(info: MovieInfo, source?: HTMLElement): void {
		this.closeLightbox?.();
		const overlay = document.body.createDiv({ cls: "amp-lightbox" });
		const card = overlay.createDiv({ cls: "amp-lightbox-card" });
		const close = card.createEl("button", { cls: "amp-lightbox-close", attr: { "aria-label": "Close" } });
		setIcon(close, "x");

		if (info.poster) {
			const img = card.createEl("img", { cls: "amp-lightbox-poster" });
			img.src = this.savedSrc.get(info.poster) ?? info.poster;
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
		const note = source ? this.itemNotes.get(source) : undefined;
		if (note) side.createDiv({ cls: "amp-lightbox-note", text: note });
		if (info.overview) side.createEl("p", { cls: "amp-lightbox-overview", text: info.overview });
		const buttons = side.createDiv({ cls: "amp-lightbox-buttons" });
		const entry: Entry = { title: info.title, year: info.year, hint: info.kind };
		const links: [string, string][] = [[info.url ? "Open Library" : "Wikipedia", sourceUrl(info)]];
		if (info.kind === "film" || info.kind === "tv") links.push(["IMDb", imdbUrl(info.title, info.year)]);
		links.push(["YouTube", this.actionUrl("youtube", entry, info)], ["Search", this.actionUrl("google", entry, info)]);
		for (const [text, url] of links) {
			const button = buttons.createEl("button", { text });
			setIcon(button.createSpan({ cls: "amp-link-icon" }), "arrow-up-right");
			button.addEventListener("click", () => window.open(url, "_blank"));
		}

		const nav = source ? this.lightboxNav(card, source, "preview") : undefined;

		this.bindDismiss(overlay, close, nav);
	}

	private bindDismiss(overlay: HTMLElement, close: HTMLElement, nav?: (direction: 1 | -1) => void): void {
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
			if (nav && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
				event.preventDefault();
				event.stopPropagation();
				nav(event.key === "ArrowRight" ? 1 : -1);
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
		const artwork = info.artwork;
		if (artwork) {
			const sized = ITUNES_SIZES.map((size) => appleArt(artwork, size));
			this.fullImages.set(key, sized);
			return sized;
		}
		if (info.url || info.posterHi) return info.posterHi ? [info.posterHi] : [];
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

	private async itunesAlbumArt(artist: string | undefined, title: string): Promise<string | null | undefined> {
		const url = new URL("https://itunes.apple.com/search");
		const term = artist ? `${artist} ${title}` : title;
		for (const [name, value] of Object.entries({ term, media: "music", entity: "album", limit: "15" })) url.searchParams.set(name, value);
		try {
			const response = await requestUrl({ url: url.toString(), throw: false });
			if (response.status !== 200) return undefined;
			const results = (response.json as { results?: ITunesResult[] }).results ?? [];
			const wanted = baseTitle(title);
			for (const result of results) {
				if (!result.artworkUrl100) continue;
				if (artist && baseTitle(result.artistName ?? "") !== baseTitle(artist)) continue;
				const name = (result.collectionName ?? "").replace(/\s+-\s+(?:single|ep)$/i, "");
				if (baseTitle(name) !== wanted) continue;
				return result.artworkUrl100;
			}
		} catch {
			return undefined;
		}
		return null;
	}

	private async itunesAlbumImages(info: MovieInfo): Promise<string[]> {
		const art = await this.itunesAlbumArt(info.artist, info.title);
		return art ? ITUNES_SIZES.map((size) => appleArt(art, size)) : [];
	}

	private openImage(info: MovieInfo, source?: HTMLElement): void {
		if (!info.poster) {
			this.openPreview(info, source);
			return;
		}
		this.closeLightbox?.();
		const overlay = document.body.createDiv({ cls: "amp-lightbox" });
		const card = overlay.createDiv({ cls: "amp-lightbox-card amp-image-card" });
		const close = card.createEl("button", { cls: "amp-lightbox-close", attr: { "aria-label": "Close" } });
		setIcon(close, "x");
		card.createDiv({ cls: "amp-image-title", text: info.year ? `${info.title} (${info.year})` : info.title });
		const img = card.createEl("img", { cls: "amp-image-full" });
		img.src = (info.poster ? this.savedSrc.get(info.poster) : undefined) ?? info.posterHi ?? info.poster;
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
		const nav = source ? this.lightboxNav(card, source, "image") : undefined;
		this.bindDismiss(overlay, close, nav);
	}

	private cacheKey(entry: Entry): string {
		const maybeAlbum = entry.hint === "album" || (!entry.hint && splitAlbum(entry.title) !== null);
		const source = maybeAlbum ? (this.settings.albumCovers === "apple" ? "apple" : "wikipedia") : "";
		return `${CACHE_PREFIX}q${this.quality().gallery}|${this.wikiLanguages().join("+")}|${source}|${entry.hint ?? ""}|${normalize(entry.title)}|${entry.year}${entry.extra ? `|${normalize(entry.extra)}` : ""}${this.tmdbActive() ? `|tmdb:${this.settings.tmdbPosters}` : ""}`;
	}

	private async lookup(entry: Entry, force: boolean): Promise<MovieInfo | null | undefined> {
		const key = this.cacheKey(entry);
		const hit = this.settings.cache[key];
		if (!force && hit) return hit.info;

		const running = this.inflight.get(key);
		if (running) return running;

		let cacheable = true;
		const task = this.throttle(async () => {
			let result = await this.searchWikipedia(entry);
			if (result?.kind === "album" && result.artist && this.settings.albumCovers === "apple") {
				const art = await this.itunesAlbumArt(result.artist, result.title);
				if (art === undefined) cacheable = false;
				else if (art) {
					const { gallery, preview } = this.quality();
					result = { ...result, poster: appleArt(art, gallery), posterHi: appleArt(art, preview), artwork: art };
				}
			}
			if (!result || (result.kind !== "film" && result.kind !== "tv") || !this.tmdbActive()) return result;
			const tmdb = await this.tmdbPoster(entry, result);
			if (tmdb === undefined || this.tmdbBroken) cacheable = false;
			return tmdb ? { ...result, ...tmdb } : result;
		}).then((result) => {
			this.inflight.delete(key);
			if (result !== undefined && cacheable) {
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

	private scorePage(page: WikiPage, kinds: Kind[], name: string, year: number, artist?: string, creators: string[] = []): { score: number; kind: Kind; matched: boolean } | null {
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
		const matched = mentionsCreator(page, kind, creators);
		if (matched) score += 60;
		return { score, kind, matched };
	}

	private pickPage(pages: WikiPage[], kinds: Kind[], name: string, year: number, artist?: string, creators: string[] = []): { page: WikiPage; kind: Kind; matched: boolean } | null {
		let best: { page: WikiPage; kind: Kind; matched: boolean } | null = null;
		let bestScore = -1;
		for (const page of pages) {
			const result = this.scorePage(page, kinds, name, year, artist, creators);
			if (result && result.score > bestScore) {
				best = { page, kind: result.kind, matched: result.matched };
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
		if (entry.hint === "book" || fallback?.kind === "book") {
			const cover = await this.openLibraryCover(entry, fallback);
			if (cover) return cover;
			if (cover === undefined) return undefined;
		}
		if (fallback) return fallback;
		return failed ? undefined : null;
	}

	private openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	resetTmdb(): void {
		this.tmdbBroken = false;
	}

	private tmdbActive(): boolean {
		return this.settings.tmdbPosters !== "off" && this.settings.tmdbKey.trim().length > 0 && !this.tmdbBroken;
	}

	private async tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null | undefined> {
		const key = this.settings.tmdbKey.trim();
		const url = new URL(`https://api.themoviedb.org/3/${path}`);
		for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
		const headers: Record<string, string> = {};
		if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
		else url.searchParams.set("api_key", key);
		try {
			const response = await requestUrl({ url: url.toString(), headers, throw: false });
			if (response.status === 401) {
				if (!this.tmdbBroken) new Notice("Media Cover Gallery: TMDB rejected the API key. Using Wikipedia posters.", 8000);
				this.tmdbBroken = true;
				return null;
			}
			if (response.status === 404) return null;
			if (response.status !== 200) return undefined;
			return response.json as T;
		} catch {
			return undefined;
		}
	}

	async testTmdbKey(): Promise<void> {
		const key = this.settings.tmdbKey.trim();
		if (!key) {
			new Notice("Media Cover Gallery: paste a TMDB API key first.");
			return;
		}
		this.tmdbBroken = false;
		const result = await this.tmdbGet<{ success?: boolean }>("authentication");
		if (result === undefined) new Notice("Media Cover Gallery: could not reach TMDB. Check your connection.");
		else if (result === null || this.tmdbBroken) new Notice("Media Cover Gallery: the TMDB API key was rejected.", 10000);
		else new Notice("Media Cover Gallery: the TMDB API key works.");
		this.tmdbBroken = false;
	}

	private async tmdbPoster(entry: Entry, info: MovieInfo): Promise<{ poster: string; posterHi: string } | null | undefined> {
		const tv = info.kind === "tv";
		const year = Number(info.year) || Number(entry.year) || 0;
		const search = (withYear: boolean): Promise<{ results?: TmdbHit[] } | null | undefined> => {
			const params: Record<string, string> = { query: entry.title, include_adult: "false" };
			if (withYear && year) params[tv ? "first_air_date_year" : "year"] = String(year);
			return this.tmdbGet(tv ? "search/tv" : "search/movie", params);
		};
		let found = await search(true);
		if (found === undefined) return undefined;
		let hits = found?.results ?? [];
		if (!hits.length && year) {
			found = await search(false);
			if (found === undefined) return undefined;
			hits = found?.results ?? [];
		}
		if (!hits.length) return null;

		const yearOf = (hit: TmdbHit): number => Number((hit.release_date ?? hit.first_air_date ?? "").slice(0, 4)) || 0;
		const fits = year ? hits.filter((hit) => Math.abs(yearOf(hit) - year) <= 1) : hits;
		if (!fits.length) return null;
		const wanted = normalize(entry.title);
		const names = (hit: TmdbHit): string[] => [hit.title, hit.name, hit.original_title, hit.original_name].map((n) => normalize(n ?? ""));
		const hit = fits.find((candidate) => names(candidate).includes(wanted)) ?? fits[0];

		const mode = this.settings.tmdbPosters;
		const textless = mode === "textless";
		const langs = [...new Set([mode === "original" && hit.original_language ? hit.original_language : this.settings.wikiMainLanguage, "en"])];
		const images = await this.tmdbGet<{ posters?: TmdbImage[] }>(`${tv ? "tv" : "movie"}/${hit.id}/images`, {
			include_image_language: textless ? "null" : langs.join(","),
		});
		if (images === undefined) return undefined;
		const posters = images?.posters ?? [];
		let pool: TmdbImage[] = [];
		for (const wanted of textless ? [null] : langs) {
			pool = posters.filter((image) => image.iso_639_1 === wanted);
			if (pool.length) break;
		}
		const best = pool.sort((a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count)[0]?.file_path;
		const path = best ?? hit.poster_path;
		if (!path) return null;

		const base = "https://image.tmdb.org/t/p/";
		const gallery = this.quality().gallery;
		const size = gallery <= 330 ? "w342" : gallery <= 500 ? "w500" : "w780";
		return { poster: `${base}${size}${path}`, posterHi: `${base}${this.quality().preview >= 960 ? "original" : "w780"}${path}` };
	}

	private async openLibraryCover(entry: Entry, base: MovieInfo | null): Promise<MovieInfo | null | undefined> {
		const year = Number(entry.year) || 0;
		const creators = creatorNames(entry.extra);
		const wanted = titleVariants(entry.title).map((variant) => baseTitle(variant));
		const search = async (author?: string): Promise<OpenLibraryDoc[] | undefined> => {
			const url = new URL("https://openlibrary.org/search.json");
			url.searchParams.set("title", entry.title);
			if (author) url.searchParams.set("author", author);
			url.searchParams.set("fields", "key,title,author_name,first_publish_year,cover_i");
			url.searchParams.set("limit", "10");
			try {
				const response = await requestUrl({ url: url.toString(), throw: false });
				if (response.status !== 200) return undefined;
				return (response.json as { docs?: OpenLibraryDoc[] }).docs ?? [];
			} catch {
				return undefined;
			}
		};

		const author = creators.length ? entry.extra?.split(/,|&|;/)[0]?.trim() : undefined;
		let docs = await search(author);
		if (docs === undefined) return undefined;
		if (!docs.length && author) {
			docs = await search();
			if (docs === undefined) return undefined;
		}

		let best: OpenLibraryDoc | null = null;
		let bestScore = -1;
		for (const doc of docs) {
			if (!doc.cover_i || !doc.title) continue;
			if (!wanted.includes(baseTitle(doc.title))) continue;
			let score = 1;
			if (year && doc.first_publish_year) {
				const gap = Math.abs(doc.first_publish_year - year);
				if (gap > 3) continue;
				score += 50 - gap * 10;
			}
			const writers = ` ${normalize((doc.author_name ?? []).join(" "))} `;
			if (creators.some((name) => writers.includes(` ${name} `))) score += 100;
			if (score > bestScore) {
				best = doc;
				bestScore = score;
			}
		}
		if (!best) return null;

		const cover = `https://covers.openlibrary.org/b/id/${best.cover_i}-L.jpg`;
		if (base) return { ...base, poster: cover, posterHi: cover };
		const title = best.title ?? entry.title;
		return {
			kind: "book",
			artist: best.author_name?.[0],
			page: title,
			lang: "en",
			title,
			year: best.first_publish_year ? String(best.first_publish_year) : entry.year,
			poster: cover,
			posterHi: cover,
			overview: "",
			url: best.key ? `https://openlibrary.org${best.key}` : undefined,
		};
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
		const creators = albumOnly ? [] : creatorNames(entry.extra);

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
		let best = this.pickPage(direct, kinds, name, year, artist, creators);

		if (!best || !best.page.thumbnail || (creators.length > 0 && !best.matched)) {
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
			if (reached) best = this.pickPage([...direct, ...more], kinds, name, year, artist, creators);
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
			key: "marginTop" | "marginBottom" | "gapHorizontal" | "gapVertical" | "groupGap" | "cornerRadius" | "titleSize",
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
		const toggle = (card: HTMLElement, name: string, key: "enableMedia" | "enableAlbums" | "addButton", rerender: boolean): void => {
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
			.setDesc("Detects one entry per line: Movie Name (2026) or Book Name (1995, Author)")
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

		const behavior = group("Behavior");
		new Setting(behavior)
			.setName("Show add entry button at end of galleries")
			.addToggle((t) =>
				t.setValue(settings.addButton).onChange(async (value) => {
					settings.addButton = value;
					await commit(true);
				}),
			);
		divider(behavior);
		new Setting(behavior).setName("Search bar above galleries").addDropdown((d) =>
			d
				.addOption("none", "Don't show")
				.addOption("left", "Aligned left")
				.addOption("center", "Centered")
				.setValue(settings.searchBar)
				.onChange(async (value) => {
					settings.searchBar = value as SearchBar;
					await commit(true);
				}),
		);
		divider(behavior);
		new Setting(behavior)
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
		divider(behavior);
		new Setting(behavior).setName("When clicking an album").addDropdown((d) =>
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
		divider(behavior);
		new Setting(behavior).setName("Sort order").addDropdown((d) =>
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
		divider(behavior);
		new Setting(behavior)
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
		divider(behavior);
		new Setting(behavior).setName("Show remove button on hover").addDropdown((d) =>
			d
				.addOption("none", "Off")
				.addOption("big", "Big")
				.addOption("small", "Small")
				.setValue(settings.removeMode)
				.onChange(async (value) => {
					settings.removeMode = value as RemoveMode;
					await commit(false);
				}),
		);
		divider(behavior);
		new Setting(behavior).setName("Show checkmark button").addDropdown((d) =>
			d
				.addOption("none", "Off")
				.addOption("hover", "On hover")
				.addOption("always", "Always show marked")
				.setValue(settings.checkMode)
				.onChange(async (value) => {
					settings.checkMode = value as CheckMode;
					await commit(false);
				}),
		);
		divider(behavior);
		let modeSelect: HTMLSelectElement;
		new Setting(behavior)
			.setName("Show rating (right-click to add a rating)")
			.addDropdown((d) =>
				d
					.addOption("none", "Off")
					.addOption("stars", "5 ★")
					.addOption("points", "10 ★")
					.setValue(settings.rating)
					.onChange(async (value) => {
						settings.rating = value as Rating;
						modeSelect.toggleClass("amp-hidden", settings.rating === "none");
						await commit(true);
					}),
			)
			.addDropdown((d) => {
				d
					.addOption("always", "Always")
					.addOption("hover", "On hover")
					.setValue(settings.ratingMode)
					.onChange(async (value) => {
						settings.ratingMode = value as RatingMode;
						await commit(false);
					});
				modeSelect = d.selectEl;
				modeSelect.toggleClass("amp-hidden", settings.rating === "none");
			});

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
		divider(appearance);
		slider(appearance, "Gap between groups", "groupGap", 0, 80, 2);

		const sources = group("Sources");
		const savedSetting = new Setting(sources).setName("Save covers on this device for offline use and to prevent loading");
		savedSetting.addToggle((toggle) =>
			toggle.setValue(settings.saveImages).onChange(async (value) => {
				settings.saveImages = value;
				await commit(true);
			}),
		);
		divider(sources);
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
				.addOption("5", "700 px")
				.addOption("4", "960 px")
				.setValue(String(settings.imageQuality))
				.onChange(async (value) => {
					settings.imageQuality = Number(value);
					await commit(true);
				}),
		);

		divider(sources);
		new Setting(sources)
			.setName("Primary music album cover source")
			.addDropdown((d) =>
				d
					.addOption("apple", "Apple Music")
					.addOption("wikipedia", "Wikipedia")
					.setValue(settings.albumCovers)
					.onChange(async (value) => {
						settings.albumCovers = value as AlbumCovers;
						await commit(true);
					}),
			);

		divider(sources);
		new Setting(sources)
			.setName("Clear cached information")
			.addButton((button) => {
				button.setButtonText("Clear cache").onClick(async () => {
					await this.plugin.clearSavedImages();
					this.plugin.clearCache();
					this.plugin.refresh(true);
					new Notice("Cache cleared.");
				});
				setIcon(button.buttonEl.createSpan({ cls: "amp-link-icon" }), "trash-2");
			});

		const tmdb = group("The Movie Database API (optional)");
		new Setting(tmdb)
			.setName("Film and TV posters")
			.setDesc("TMDB can provide sleeker posters, but it requires a free API key.")
			.addDropdown((d) =>
				d
					.addOption("off", "Wikipedia")
					.addOption("title", "TMDB with title")
					.addOption("original", "TMDB in original language")
					.addOption("textless", "TMDB textless")
					.setValue(settings.tmdbPosters)
					.onChange(async (value) => {
						settings.tmdbPosters = value as TmdbPosters;
						this.plugin.resetTmdb();
						await commit(true);
					}),
			);
		divider(tmdb);
		new Setting(tmdb)
			.setName("Get an API key")
			.setDesc("Create and copy a personal use API key. Logging in is required.")
			.addButton((button) => {
				button.setButtonText("TMDB API settings").onClick(() => {
					window.open("https://www.themoviedb.org/settings/api", "_blank");
				});
				setIcon(button.buttonEl.createSpan({ cls: "amp-link-icon" }), "arrow-up-right");
			});
		divider(tmdb);
		let changed = false;
		new Setting(tmdb)
			.setName("TMDB API key")
			.setDesc("The key is stored unencrypted in this plugin's data file.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("API key")
					.setValue(settings.tmdbKey)
					.onChange(async (value) => {
						settings.tmdbKey = value.trim();
						this.plugin.resetTmdb();
						changed = true;
						await this.plugin.saveSettings();
					});
				text.inputEl.addEventListener("blur", () => {
					if (!changed) return;
					changed = false;
					void commit(true);
				});
			});
		divider(tmdb);
		new Setting(tmdb).setName("Test API key").addButton((button) =>
			button.setButtonText("Test key").onClick(async () => {
				await this.plugin.testTmdbKey();
			}),
		);

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


class GalleryWidget extends WidgetType {
	private observer: ResizeObserver | null = null;

	constructor(
		private readonly plugin: MoviePosterPlugin,
		private readonly lines: string[],
		private readonly version: number,
	) {
		super();
	}

	eq(other: GalleryWidget): boolean {
		return other.version === this.version && other.lines.length === this.lines.length && other.lines.every((line, i) => line === this.lines[i]);
	}

	toDOM(view: EditorView): HTMLElement {
		const dom = this.plugin.renderLive(view, this.lines);
		this.observer = new ResizeObserver(() => view.requestMeasure());
		this.observer.observe(dom);
		return dom;
	}

	destroy(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	ignoreEvent(): boolean {
		return true;
	}
}
