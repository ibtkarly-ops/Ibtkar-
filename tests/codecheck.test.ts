// deno test -A --no-check tests/codecheck.test.ts
// The app builder's real code checks: what would be a red screen in Expo Go is either repaired or rejected with an exact reason.
import { checkCode, exportInfo, exportsLabel, importMismatch, repairCode } from "../supabase/functions/ai-gateway/codecheck.ts";

function assert(c: unknown, msg: string) { if (!c) throw new Error("ASSERT: " + msg); }

const SCREEN = `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
export default function Home() {
  const [n, setN] = useState(0);
  return (<View style={s.box}><ScrollView><Text>{n}</Text></ScrollView></View>);
}
const s = StyleSheet.create({ box: { flex: 1 } });`;

Deno.test("a forgotten import of a well-known component or hook is added (no extra AI call), and the file then passes", () => {
  assert(/undefined:.*(useState|ScrollView)/.test(checkCode(SCREEN) ?? ""), "detected first: " + checkCode(SCREEN));
  const r = repairCode(SCREEN);
  assert(/import React, \{ useState \} from 'react'/.test(r.code), "hook added to the React import:\n" + r.code);
  assert(/import \{ View, Text, StyleSheet , ScrollView \} from 'react-native'/.test(r.code), "component added to the react-native import:\n" + r.code);
  assert(checkCode(r.code) === null && r.fixed.length === 2, "passes after repair " + checkCode(r.code) + " " + r.fixed);
});

Deno.test("missing modules get their own import line: named, default (AsyncStorage) and namespace (Haptics)", () => {
  const code = `export default function A() {
  const save = async () => { await AsyncStorage.setItem('k', '1'); Haptics.selectionAsync(); };
  return <LinearGradient colors={['#000', '#fff']}><Pressable onPress={save} /></LinearGradient>;
}`;
  const r = repairCode(code);
  assert(r.code.includes(`import AsyncStorage from "@react-native-async-storage/async-storage";`), "default import");
  assert(r.code.includes(`import * as Haptics from "expo-haptics";`), "namespace import");
  assert(r.code.includes(`import { LinearGradient } from "expo-linear-gradient";`) && r.code.includes(`import { Pressable } from "react-native";`), "named imports");
  assert(checkCode(r.code) === null, "passes: " + checkCode(r.code));
});

Deno.test("uuid / nanoid (not in Expo Go) become a small local id function", () => {
  const r = repairCode(`import { v4 as uuidv4 } from 'uuid';\nimport { View } from 'react-native';\nexport const make = () => ({ id: uuidv4() });\nexport default function X() { return <View />; }`);
  assert(!/from 'uuid'/.test(r.code) && /const uuidv4 = \(\) =>/.test(r.code) && r.fixed.includes("shim:uuid"), "shimmed:\n" + r.code);
  assert(checkCode(r.code) === null, "passes");
});

Deno.test("what cannot be repaired is rejected with a precise reason", () => {
  const cut = SCREEN.slice(0, SCREEN.indexOf("<ScrollView>") + 20);   // output cut off by the token limit
  assert(/^syntax:\d+:\d+ /.test(checkCode(cut) ?? ""), "truncated file: " + checkCode(cut));
  assert(repairCode(cut).code === cut, "a broken file is never rewritten");
  assert(/^html_tag:div/.test(checkCode(`import { Text } from 'react-native';\nexport default () => <div><Text>x</Text></div>;`) ?? ""), "HTML tag");
  assert(/^undefined:ProductCard/.test(checkCode(`import { View } from 'react-native';\nexport default () => <View><ProductCard /></View>;`) ?? ""), "own component that was never imported");
});

Deno.test("no false alarms: navigators, components defined below, globals, destructured params, React.memo with import", () => {
  const ok = `import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
const Stack = createNativeStackNavigator();
export default function App() { return (<Stack.Navigator><Stack.Screen name="a" component={Row} /></Stack.Navigator>); }
function Row({ item: { title } = {}, ...rest }) { const n = Math.max(1, JSON.stringify(rest).length); return <View><Text>{title}{n}{new Date().getFullYear()}</Text></View>; }
export const Memo = React.memo(Row);
try { Number('1'); } catch (Err) { console.log(Err); }`;
  assert(checkCode(ok) === null, "clean file passes: " + checkCode(ok));
  assert(repairCode(ok).fixed.length === 0, "nothing to repair");
});

Deno.test("exports are read from the syntax tree, and imports between the app's own files must match them", () => {
  const theme = `const colors = { a: 1 };\nexport const spacing = 4;\nexport { colors };\nexport default colors;`;
  const e = exportInfo(theme);
  assert(e.def && e.names.includes("spacing") && e.names.includes("colors"), "exports " + JSON.stringify(e));
  assert(exportsLabel(`export default function HomeScreen() { return null }\nexport const x = 1;`) === "default HomeScreen, x", "label");
  const others = { "src/theme.js": theme, "src/screens/Home.js": "export function Home() { return null }" };
  assert(importMismatch("App.js", `import colors, { spacing } from './src/theme';\nimport { Home } from './src/screens/Home';`, others) === null, "matching imports pass");
  const bad = importMismatch("App.js", `import Home from './src/screens/Home';`, others);
  assert(bad?.target === "src/screens/Home.js" && /import_mismatch:\.\/src\/screens\/Home:default \(src\/screens\/Home\.js exports: Home\)/.test(bad.reason), "default vs named: " + JSON.stringify(bad));
  const lab = importMismatch("src/screens/Home.js", `import { theme } from '../theme';`, { "src/theme.js": "default colors, spacing" }, true);
  assert(lab && /:theme /.test(lab.reason), "checked against the exports label of an already written file: " + JSON.stringify(lab));
});

Deno.test("hardening: prettier-style multi-line imports with a trailing comma, typed arrays, <this.X/>, export * and CommonJS never cause a false alarm", () => {
  const multi = `import React from 'react';
import {
  View,
  Text,
} from 'react-native';
export default function A() { return <View><Text><ScrollView /></Text></View>; }`;
  const r = repairCode(multi);
  assert(r.fixed.length === 1 && /ScrollView,?\s*\n?\} from 'react-native'/.test(r.code) && checkCode(r.code) === null, "trailing comma handled:\n" + r.code);
  assert(checkCode(`import { View } from 'react-native';\nexport default function A() { const b = new Float64Array(4); const u = new Uint16Array(2); return <View />; }`) === null, "typed arrays are globals");
  assert(checkCode(`import React from 'react';\nimport { View } from 'react-native';\nexport default class A extends React.Component { Row = () => <View />; render() { return <this.Row />; } }`) === null, "<this.Row/>");
  const barrel = { "src/components/index.js": "export * from './Card';", "src/components/Card.js": "export const Card = () => null;", "src/legacy.js": "module.exports = { thing: 1 };" };
  assert(importMismatch("App.js", `import { Card } from './src/components';\nimport { thing } from './src/legacy';`, barrel) === null, "re-exports and CommonJS are unknown, not wrong");
  assert(importMismatch("App.js", `import { defaultTheme } from './t';`, { "t.js": "export const defaultTheme = 1;" }) === null, "a name that starts with 'default' is a normal name");
  assert(importMismatch("x.js", `import { defaultTheme } from './t';`, { "t.js": "default Home, defaultTheme" }, true) === null, "…also in an exports label");
  const id = repairCode(`import uuid from 'uuid';\nimport { nanoid } from 'nanoid';\nexport const a = () => uuid.v4() + nanoid();\nexport default function X() { return null; }`);
  assert(!/from 'uuid'|from 'nanoid'/.test(id.code) && checkCode(id.code) === null, "default and named id imports are both replaced:\n" + id.code);
});
