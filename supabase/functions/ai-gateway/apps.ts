// Expo / React Native app builder (Mobtakir-style): chat -> one question only if essential -> plan card ->
// files written one by one (each call fits a free provider's per-minute limit) -> commit -> Expo Go via Snack.

export const SDK = "58.0.0";
export const ALLOWED = new Set([
  "react", "react-native", "expo", "expo-status-bar", "@expo/vector-icons",
  "@react-navigation/native", "@react-navigation/bottom-tabs", "@react-navigation/native-stack",
  "react-native-screens", "react-native-safe-area-context", "react-native-gesture-handler", "react-native-reanimated",
  "@react-native-async-storage/async-storage", "expo-linear-gradient", "expo-haptics", "expo-image", "expo-font",
  "expo-constants", "expo-linking", "expo-web-browser", "expo-clipboard", "expo-sharing", "expo-image-picker",
  "expo-location", "expo-notifications", "expo-blur", "expo-av",
]);
/** packages that come with Expo itself and never go in the Snack dependency list */
const BUILTIN = new Set(["react", "react-native", "expo"]);

export const isCodePath = (p: string) => /^(App\.js|src\/(?:[\w-]+\/){0,3}[\w-]+\.jsx?)$/.test(p);
const base = (spec: string) => spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

/** Every module a file loads: import x from, bare import, require(), dynamic import(), export ... from. */
export function importsOf(code: string): string[] {
  const out: string[] = [];
  for (const re of [/(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g, /import\s*['"]([^'"]+)['"]/g, /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g])
    for (const m of code.matchAll(re)) out.push(m[1]);
  if (/require\s*\(\s*[^'"\s)]/.test(code) || /import\s*\(\s*[^'"\s)]/.test(code)) out.push("<dynamic>");
  return [...new Set(out)];
}

function resolveRel(from: string, spec: string, paths: Set<string>): boolean {
  const dir = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") { if (!dir.length) return false; dir.pop(); } else dir.push(part);
  }
  const p = dir.join("/");
  return [p, p + ".js", p + ".jsx", p + "/index.js"].some((x) => paths.has(x));
}

/** null when the file is acceptable, otherwise a short reason. */
export function validFile(path: string, code: string, paths: Set<string>): string | null {
  if (!isCodePath(path)) return "bad_path";
  if (code.length < 20 || code.length > 40_000) return "bad_length";
  if (/\beval\s*\(|new\s+Function\s*\(|document\.cookie|child_process|process\.env/.test(code)) return "unsafe_code";
  if (path === "App.js" && !/export\s+default/.test(code)) return "no_default_export";
  for (const spec of importsOf(code)) {
    if (spec === "<dynamic>") return "dynamic_import";
    if (spec.startsWith(".")) { if (!resolveRel(path, spec, paths)) return "missing_file:" + spec; continue; }
    if (!(ALLOWED.has(base(spec)) || spec.startsWith("@expo/vector-icons/"))) return "import_not_allowed:" + spec;
  }
  return null;
}

export function depsOf(files: Record<string, string>): string[] {
  const s = new Set<string>();
  for (const [p, c] of Object.entries(files)) if (isCodePath(p)) for (const spec of importsOf(c)) if (!spec.startsWith(".") && spec !== "<dynamic>") { const b = base(spec); if (!BUILTIN.has(b)) s.add(b); }
  if (s.has("@react-navigation/native")) { s.add("react-native-screens"); s.add("react-native-safe-area-context"); }
  return [...s].sort();
}

const str = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, n) : "");
const hex = (v: unknown, d: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
export const slugOf = (name: string, id: string) => (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "app") + "-" + id.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();

export function cleanPlan(p: any) {
  const o = p && typeof p === "object" ? p : {};
  const files = (Array.isArray(o.files) ? o.files : []).slice(0, 14).map((f: any) => ({ path: str(f?.path, 80), purpose: str(f?.purpose, 200) })).filter((f: any) => isCodePath(f.path));
  if (!files.some((f: any) => f.path === "App.js")) files.unshift({ path: "App.js", purpose: "نقطة الدخول والتنقل بين الشاشات" });
  return {
    name: str(o.name, 40) || "تطبيقي", summary: str(o.summary, 400), icon: str(o.icon, 4),
    screens: (Array.isArray(o.screens) ? o.screens : []).slice(0, 10).map((s: any) => ({ name: str(s?.name, 40), purpose: str(s?.purpose, 160) })).filter((s: any) => s.name),
    colors: { primary: hex(o.colors?.primary, "#5b4ae0"), background: hex(o.colors?.background, "#ffffff"), text: hex(o.colors?.text, "#111827") },
    features: (Array.isArray(o.features) ? o.features : []).slice(0, 10).map((x: unknown) => str(x, 120)).filter(Boolean),
    files,
  };
}

/** Project files the AI never writes: entry point, app.json, package.json, eas.json, README. */
export function projectConfig(app: { name: string; slug: string; plan?: any }, files: Record<string, string>) {
  const deps = depsOf(files), pkg = `ly.ibtkar.${app.slug.replace(/[^a-z0-9]/g, "").slice(0, 40) || "app"}`;
  const bg = app.plan?.colors?.background ?? "#ffffff";
  return {
    "index.js": "import { registerRootComponent } from 'expo';\nimport App from './App';\n\nregisterRootComponent(App);\n",
    "app.json": JSON.stringify({ expo: { name: app.name, slug: app.slug, version: "1.0.0", orientation: "portrait", userInterfaceStyle: "automatic", splash: { backgroundColor: bg }, ios: { bundleIdentifier: pkg, supportsTablet: true }, android: { package: pkg, adaptiveIcon: { backgroundColor: bg } } } }, null, 2),
    "package.json": JSON.stringify({ name: app.slug, version: "1.0.0", main: "index.js", private: true, scripts: { start: "expo start", android: "expo start --android", ios: "expo start --ios" }, dependencies: Object.fromEntries([["expo", `~${SDK}`], ...deps.map((d) => [d, "*"])]) }, null, 2),
    "eas.json": JSON.stringify({ cli: { appVersionSource: "remote" }, build: { preview: { distribution: "internal", android: { buildType: "apk" } }, production: { autoIncrement: true } }, submit: { production: {} } }, null, 2),
    "README.md": `# ${app.name}\n\nمشروع Expo (React Native) أنشأته منصة ابتكار.\n\n## التشغيل\n1. \`npm install\` ثم \`npx expo install --fix\` (يضبط إصدارات المكتبات على SDK ${SDK.split(".")[0]}).\n2. \`npx expo start\` وامسح الرمز بتطبيق Expo Go.\n\n## البناء للمتاجر\n\`npx eas-cli build -p android --profile preview\` (APK) أو \`--profile production\` (AAB / iOS).\n`,
  };
}

/** Expo Snack link that loads every file from a URL (short signed links), so the link stays short. */
export function snackUrl(name: string, fileUrls: Record<string, string>, deps: string[], platform: "mydevice" | "web" = "mydevice") {
  const files = Object.fromEntries(Object.entries(fileUrls).map(([p, url]) => [p, { type: "CODE", url }]));
  const q = new URLSearchParams({ name, sdkVersion: SDK, platform, supportedPlatforms: "mydevice,ios,android,web", dependencies: deps.join(","), files: JSON.stringify(files) });
  return `https://snack.expo.dev/${platform === "web" ? "embedded" : ""}?${q.toString()}${platform === "web" ? "&preview=true&theme=light" : ""}`;
}

export function extractCode(text: string): string | null {
  const m = /```(?:jsx|js|javascript|tsx|ts)?[ \t]*\r?\n([\s\S]*?)```/.exec(text);
  if (m) return m[1].trim();
  const t = text.trim();
  return /^(import|export|const|function)\b/.test(t) ? t : null;
}

/** exported names of a file, so another file can be written against it without sending its whole code */
export const exportsOf = (code: string) => [...code.matchAll(/export\s+(default\s+)?(?:function|const|class|let)\s+(\w+)/g)].map((m) => (m[1] ? "default " : "") + m[2]).join(", ");

export const APP_CHAT_PROMPT = `أنت مهندس تطبيقات جوال في منصة ابتكار (مثل «مبتكر»): المستخدم يصف تطبيقه بكلماته، وأنت تخطّط وتبني تطبيق Expo (React Native) حقيقياً يُجرَّب فوراً في Expo Go.
أعد JSON فقط بأحد الأشكال:
1) {"type":"question","text":"سؤال واحد قصير"} فقط إذا كانت فكرة التطبيق نفسها غير مفهومة ولا يمكن التخطيط بدونها. لا تسأل عن التقنية أو الألوان أو التفاصيل التي تستطيع اختيارها.
2) {"type":"plan","text":"رسالة قصيرة","plan":{"name":"اسم التطبيق","summary":"وصف في جملتين","icon":"إيموجي واحد","screens":[{"name":"الرئيسية","purpose":"..."}],"colors":{"primary":"#RRGGBB","background":"#RRGGBB","text":"#RRGGBB"},"features":["..."],"files":[{"path":"App.js","purpose":"..."},{"path":"src/theme.js","purpose":"..."},{"path":"src/screens/HomeScreen.js","purpose":"..."}]}} لتطبيق جديد أو إعادة بناء كبيرة. من 3 إلى 6 شاشات، ومن 4 إلى 12 ملفاً: App.js (NavigationContainer وشريط تبويب سفلي أو Stack)، src/theme.js (الألوان والخطوط)، ملف لكل شاشة في src/screens، ومكونات مشتركة في src/components، وsrc/storage.js إذا لزم حفظ بيانات.
3) {"type":"edit","text":"ما ستغيّره","files":[{"path":"...","purpose":"ما يتغير فيه"}]} لتعديل تطبيق موجود: الملفات التي تتغير أو تُضاف فقط.
4) {"type":"answer","text":"..."} لسؤال لا يحتاج كوداً.
اكتب بالعربية. الشاشات والميزات حقيقية تخدم فكرة المستخدم، بلا شاشات فارغة أو أزرار وهمية.`;

export const APP_FILE_PROMPT = `اكتب ملفاً واحداً فقط من تطبيق Expo SDK ${SDK.split(".")[0]} بلغة JavaScript (ليس TypeScript)، وفق خطة التطبيق وقائمة ملفاته المعطاة.
القواعد:
- مكونات دوال وhooks، وStyleSheet، وملف واحد لا يتجاوز 220 سطراً.
- المكتبات المسموحة فقط: react، react-native، expo، expo-status-bar، @expo/vector-icons، @react-navigation/native و bottom-tabs و native-stack، react-native-safe-area-context، react-native-screens، @react-native-async-storage/async-storage، expo-linear-gradient، expo-haptics، expo-image، expo-linking، expo-web-browser، expo-clipboard، expo-sharing، expo-image-picker. والاستيراد النسبي فقط لملفات موجودة في قائمة الملفات.
- ممنوع أي مكتبة خارج القائمة أعلاه (مثل date-fns وaxios وlodash وmoment وuuid): اكتب الدوال المساعدة (التواريخ، المعرّفات، التنسيق) بنفسك بجافاسكربت عادي.
- written_exports يبيّن ما صدّرته الملفات المكتوبة سابقاً: استوردها بالاسم نفسه ونوع التصدير نفسه (default أو named). وملفك يصدّر ما تذكره خطة الملفات.
- استخدم الألوان من src/theme.js إن وُجد. ادعم العربية: textAlign "right" وwritingDirection "rtl" للنصوص العربية.
- كل زر يؤدي وظيفة حقيقية، وحالات التحميل والفراغ والخطأ موجودة، والبيانات تُحفظ بـ AsyncStorage عند الحاجة. لا اتصال بخوادم أو مفاتيح سرية.
- لا تخترع أرقام هواتف أو حسابات حقيقية؛ البيانات الأولية واضحة أنها أمثلة.
أعد محتوى الملف كاملاً فقط داخل كتلة \`\`\`jsx واحدة بلا أي شرح.`;
