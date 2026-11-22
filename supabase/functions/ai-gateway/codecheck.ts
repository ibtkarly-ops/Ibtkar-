// Real code checks for the Expo app builder (2026-11-22).
//
// The regex checks in apps.ts only look at import lines. What actually crashes an app in Expo Go is different:
// a syntax error or a file cut off by the token limit, a component or hook used without being imported
// (<ScrollView> with no import -> "ScrollView is not defined"), an HTML tag (<div>) that React Native does not
// have, or `import { colors } from "./theme"` when theme.js only has a default export. Each of these is a red
// screen. This module parses the JSX (acorn + acorn-jsx) and:
//   repairCode()  fixes what is safe to fix without asking the AI again (missing imports of well-known symbols,
//                 uuid/nanoid -> a tiny local id function), so a build is faster and needs fewer AI round-trips;
//   checkCode()   rejects what it cannot fix with a precise reason that is sent back to the AI as `fix`;
//   exportInfo() / importMismatch()  make imports between the app's own files match what each file exports.
import * as acorn from "npm:acorn@8.14.0";
import jsx from "npm:acorn-jsx@5.3.2";

const Parser = acorn.Parser.extend(jsx());
const OPTS = { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true } as const;

type Node = { type: string; start: number; end: number; [k: string]: any };
export function parse(code: string): Node { return Parser.parse(code, OPTS as any) as unknown as Node; }

function walk(node: any, fn: (n: Node, parent: Node | null) => void, parent: Node | null = null) {
  if (!node || typeof node.type !== "string") return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, fn, node); }
    else if (v && typeof v.type === "string") walk(v, fn, node);
  }
}

function patternNames(p: any, out: Set<string>) {
  if (!p) return;
  if (p.type === "Identifier") out.add(p.name);
  else if (p.type === "ObjectPattern") for (const pr of p.properties) patternNames(pr.type === "RestElement" ? pr.argument : pr.value, out);
  else if (p.type === "ArrayPattern") for (const el of p.elements) patternNames(el, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
}

/** Every name the file declares anywhere (lenient: scopes are ignored, so this never reports a false "undefined"). */
function declared(ast: Node): Set<string> {
  const out = new Set<string>();
  walk(ast, (n) => {
    if (n.type === "ImportSpecifier" || n.type === "ImportDefaultSpecifier" || n.type === "ImportNamespaceSpecifier") out.add(n.local.name);
    else if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration" || n.type === "FunctionExpression" || n.type === "ClassExpression") && n.id) out.add(n.id.name);
    else if (n.type === "VariableDeclarator") patternNames(n.id, out);
    else if (n.type === "CatchClause" && n.param) patternNames(n.param, out);
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") for (const p of n.params) patternNames(p, out);
  });
  return out;
}

const GLOBALS = new Set(["Math", "JSON", "Date", "Object", "Array", "Promise", "Number", "String", "Boolean", "Intl", "Error", "TypeError", "RangeError",
  "Symbol", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "Reflect", "Proxy", "BigInt", "Infinity", "NaN", "URL", "URLSearchParams", "AbortController",
  "TextEncoder", "TextDecoder", "FormData", "Blob", "Headers", "Response", "Request", "ArrayBuffer", "DataView", "Function", "WebSocket", "XMLHttpRequest",
  "Event", "EventTarget", "File", "FileReader", "DOMException", "Atomics", "SharedArrayBuffer", "WeakRef", "FinalizationRegistry", "ErrorUtils", "AggregateError", "EvalError", "SyntaxError", "URIError"]);
const TYPED = /^(Big)?(Int|Uint|Float)\d+(Clamped)?Array$/;

/** Names used in a way that crashes when they are not defined: <Comp>, <Tab.Screen>, useX(), createX(), Upper.member. */
function used(ast: Node): { names: Set<string>; html: Set<string> } {
  const names = new Set<string>(), html = new Set<string>();
  walk(ast, (n, parent) => {
    if (n.type === "JSXOpeningElement") {
      const nm = n.name;
      if (nm.type === "JSXIdentifier") { if (/^[A-Z]/.test(nm.name)) names.add(nm.name); else html.add(nm.name); }
      else if (nm.type === "JSXMemberExpression") { let o = nm; while (o.type === "JSXMemberExpression") o = o.object; if (o.type === "JSXIdentifier") names.add(o.name); }
    } else if (n.type === "CallExpression" && n.callee.type === "Identifier" && /^(use[A-Z]|create[A-Z])/.test(n.callee.name)) names.add(n.callee.name);
    else if (n.type === "MemberExpression" && n.object.type === "Identifier" && /^[A-Z]/.test(n.object.name) && !(parent && parent.type === "MemberExpression" && parent.property === n && !parent.computed)) names.add(n.object.name);
  });
  for (const g of [...names]) if (GLOBALS.has(g) || TYPED.test(g) || g === "this") names.delete(g);
  return { names, html };
}

// Well-known symbols and where they come from: a missing import of one of these is added automatically.
type Src = { mod: string; kind: "named" | "default" | "namespace" };
const KNOWN: Record<string, Src> = {};
const add = (mod: string, kind: Src["kind"], list: string) => list.split(/\s+/).filter(Boolean).forEach((n) => (KNOWN[n] = { mod, kind }));
add("react", "named", "useState useEffect useMemo useCallback useRef useContext useReducer useLayoutEffect createContext Fragment memo forwardRef");
add("react", "default", "React");
add("react-native", "named", `View Text ScrollView FlatList SectionList TouchableOpacity TouchableHighlight TouchableWithoutFeedback Pressable Image
  ImageBackground TextInput StyleSheet Alert Platform Dimensions KeyboardAvoidingView ActivityIndicator Switch Modal Animated Easing Linking Share
  RefreshControl Keyboard useWindowDimensions useColorScheme I18nManager Vibration LayoutAnimation AppState BackHandler PixelRatio Appearance`);
add("react-native-safe-area-context", "named", "SafeAreaProvider SafeAreaView useSafeAreaInsets");
add("expo-status-bar", "named", "StatusBar");
add("expo-linear-gradient", "named", "LinearGradient");
add("@expo/vector-icons", "named", "Ionicons MaterialIcons MaterialCommunityIcons Feather FontAwesome FontAwesome5 AntDesign Entypo");
add("@react-navigation/native", "named", "NavigationContainer useNavigation useRoute useFocusEffect useIsFocused useNavigationState useScrollToTop DefaultTheme DarkTheme CommonActions StackActions");
add("@react-navigation/bottom-tabs", "named", "useBottomTabBarHeight");
add("react-native-safe-area-context", "named", "useSafeAreaFrame SafeAreaInsetsContext");
add("@react-navigation/bottom-tabs", "named", "createBottomTabNavigator");
add("@react-navigation/native-stack", "named", "createNativeStackNavigator");
add("@react-native-async-storage/async-storage", "default", "AsyncStorage");
add("expo-haptics", "namespace", "Haptics");
add("expo-image-picker", "namespace", "ImagePicker");
add("expo-clipboard", "namespace", "Clipboard");
add("expo-sharing", "namespace", "Sharing");
add("expo-web-browser", "namespace", "WebBrowser");

const ID = "Date.now().toString(36) + Math.random().toString(36).slice(2, 10)";
function idShim(s: any): string {
  const n = s.local.name;
  if (s.type === "ImportSpecifier") return (s.imported.name ?? s.imported.value) === "customAlphabet" ? `const ${n} = () => () => ${ID};` : `const ${n} = () => ${ID};`;
  return `const ${n} = Object.assign(() => ${ID}, { v4: () => ${ID}, v1: () => ${ID}, nanoid: () => ${ID} });`;   // default / namespace import
}

/** Fix what is safe to fix. Returns the new code and what was fixed (empty when nothing changed or the file does not parse). */
export function repairCode(code: string): { code: string; fixed: string[] } {
  const fixed: string[] = [];
  for (let round = 0; round < 2; round++) {
    let ast: Node;
    try { ast = parse(code); } catch { return { code, fixed }; }
    const edits: { at: number; end?: number; text: string }[] = [];
    const imports = ast.body.filter((n: Node) => n.type === "ImportDeclaration");
    // uuid / nanoid are not available in Expo Go: a local id function does the same job
    for (const d of imports) if (["uuid", "nanoid", "react-native-uuid"].includes(d.source.value)) {
      edits.push({ at: d.start, end: d.end, text: d.specifiers.map(idShim).join("\n") || "" });
      fixed.push("shim:" + d.source.value);
    }
    const have = declared(ast), { names } = used(ast);
    const missing = [...names].filter((n) => !have.has(n) && KNOWN[n]);
    const byMod = new Map<string, string[]>();
    for (const n of missing) { const k = KNOWN[n]; const key = k.mod + "|" + k.kind; byMod.set(key, [...(byMod.get(key) ?? []), n]); }
    const lastImportEnd = imports.length ? imports[imports.length - 1].end : 0;
    for (const [key, list] of byMod) {
      const [mod, kind] = key.split("|");
      const decl = imports.find((d: Node) => d.source.value === mod && !d.specifiers.some((s: any) => s.type === "ImportNamespaceSpecifier"));
      if (kind === "named" && decl) {
        const src = code.slice(decl.start, decl.end), named = decl.specifiers.some((s: any) => s.type === "ImportSpecifier");
        if (named) {
          const closeIdx = src.lastIndexOf("}"), trailing = src.slice(0, closeIdx).trimEnd().endsWith(",");
          edits.push({ at: decl.start + closeIdx, text: (trailing ? " " : ", ") + list.join(", ") + (trailing ? ",\n" : " ") });
        }
        else { const def = decl.specifiers.find((s: any) => s.type === "ImportDefaultSpecifier"); if (def) edits.push({ at: def.end, text: ", { " + list.join(", ") + " }" }); else edits.push({ at: lastImportEnd, text: `\nimport { ${list.join(", ")} } from "${mod}";` }); }
      } else if (kind === "default" && decl && !decl.specifiers.some((s: any) => s.type === "ImportDefaultSpecifier")) {
        edits.push({ at: decl.start + "import".length, text: " " + list[0] + "," });
      } else {
        const line = kind === "named" ? `import { ${list.join(", ")} } from "${mod}";` : kind === "default" ? `import ${list[0]} from "${mod}";` : list.map((n) => `import * as ${n} from "${mod}";`).join("\n");
        edits.push({ at: lastImportEnd, text: (lastImportEnd ? "\n" : "") + line + (lastImportEnd ? "" : "\n") });
      }
      fixed.push("import:" + list.join(","));
    }
    if (!edits.length) break;
    edits.sort((a, b) => b.at - a.at);
    let out = code;
    for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end ?? e.at);
    try { parse(out); code = out; } catch { return { code, fixed: [] }; }   // never make a file worse
  }
  return { code, fixed: [...new Set(fixed)] };
}

/** What a file exports, read from its syntax tree. */
export function exportInfo(code: string): { def: boolean; defName: string; names: string[]; open: boolean } {
  const out = { def: false, defName: "", names: [] as string[], open: /\bmodule\.exports\b|\bexports\.\w+\s*=/.test(code) };   // open = we cannot know the full export list
  let ast: Node;
  try { ast = parse(code); } catch { return out; }
  for (const n of ast.body) {
    if (n.type === "ExportAllDeclaration") out.open = true;
    else if (n.type === "ExportDefaultDeclaration") { out.def = true; out.defName = n.declaration?.id?.name ?? (n.declaration?.type === "Identifier" ? n.declaration.name : ""); }
    else if (n.type === "ExportNamedDeclaration") {
      if (n.declaration) {
        if (n.declaration.id) out.names.push(n.declaration.id.name);
        for (const d of n.declaration.declarations ?? []) { const s = new Set<string>(); patternNames(d.id, s); out.names.push(...s); }
      }
      for (const s of n.specifiers ?? []) { const nm = s.exported.name ?? s.exported.value; if (nm === "default") out.def = true; else out.names.push(nm); }
    }
  }
  return out;
}
/** "default HomeScreen, colors" — the format the AI sees as written_exports. */
export const exportsLabel = (code: string) => { const e = exportInfo(code); return [e.def ? ("default " + e.defName).trim() : "", ...e.names].filter(Boolean).join(", "); };
const fromLabel = (label: string) => { const parts = String(label ?? "").split(",").map((x) => x.trim()).filter(Boolean), isDef = (p: string) => /^default(\s|$)/.test(p); return { def: parts.some(isDef), names: parts.filter((p) => !isDef(p)), open: false }; };

export function resolvePath(from: string, spec: string, paths: Iterable<string>): string | null {
  const set = new Set(paths), dir = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") { if (!dir.length) return null; dir.pop(); } else dir.push(part);
  }
  const p = dir.join("/");
  return [p, p + ".js", p + ".jsx", p + "/index.js"].find((x) => set.has(x)) ?? null;
}

/** First import of an own file that asks for something that file does not export (null when all match).
 *  `others` maps a path to its code or to its exports label; files not in `others` are not checked yet. */
export function importMismatch(path: string, code: string, others: Record<string, string>, isLabel = false): { reason: string; target: string } | null {
  let ast: Node;
  try { ast = parse(code); } catch { return null; }
  for (const d of ast.body) {
    if (d.type !== "ImportDeclaration" || !String(d.source.value).startsWith(".")) continue;
    const target = resolvePath(path, d.source.value, Object.keys(others));
    if (!target) continue;
    const ex = isLabel ? fromLabel(others[target]) : exportInfo(others[target]);
    if (ex.open) continue;
    const show = `(${target} exports: ${[ex.def ? "default" : "", ...ex.names].filter(Boolean).join(", ") || "nothing"})`;
    for (const s of d.specifiers) {
      if (s.type === "ImportDefaultSpecifier" && !ex.def) return { reason: `import_mismatch:${d.source.value}:default ${show}`, target };
      if (s.type === "ImportSpecifier") { const nm = s.imported.name ?? s.imported.value; if (nm === "default" ? !ex.def : !ex.names.includes(nm)) return { reason: `import_mismatch:${d.source.value}:${nm} ${show}`, target }; }
    }
  }
  return null;
}

/** null when the code is safe to run, otherwise a precise reason for the AI. */
export function checkCode(code: string): string | null {
  let ast: Node;
  try { ast = parse(code); }
  catch (e) {
    const m = String((e as Error).message), loc = (e as any).loc;
    return `syntax:${loc ? loc.line + ":" + loc.column : "?"} ${m.replace(/\s*\(\d+:\d+\)$/, "")}`.slice(0, 140);
  }
  const have = declared(ast), { names, html } = used(ast);
  if (html.size) return "html_tag:" + [...html].slice(0, 3).join(",") + " (React Native has no HTML tags: use View/Text/Image/Pressable)";
  const undef = [...names].filter((n) => !have.has(n));
  if (undef.length) return "undefined:" + undef.slice(0, 4).join(",") + " (import or define it)";
  return null;
}
