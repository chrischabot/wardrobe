#!/usr/bin/env python3
"""Static rules for ios/App that a syntax parse cannot see.

1. Accessibility identifiers: the UI tests keep a literal copy of AXID (they do not link GarderobeKit).
   The copy must be identical to GarderobeKit/Presentation/AccessibilityIdentifiers.swift.
2. No recommendation or domain logic in the presentation layer: the app sources may not send a
   command or call the API directly (everything goes through a feature model), with the two
   documented exceptions listed below.
3. No placeholder UI text, no "new chat" action, no streak or score wording.
4. Every view type the root expects exists exactly once, and no top-level type is declared twice.
"""
import re
import sys
from pathlib import Path

ios = Path(__file__).resolve().parents[1]
app = ios / "App"
failures = []


def fail(message):
    failures.append(message)


# 1. AXID copy
kit_axid = (ios / "GarderobeKit/Sources/GarderobeKit/Presentation/AccessibilityIdentifiers.swift").read_text()
ui_axid_path = app / "GarderobeUITests/AXID.swift"


def axid_members(text):
    members = {}
    for match in re.finditer(r"static (?:let (\w+) = (\"[^\"]*\")|func (\w+)\(([^)]*)\) -> String \{ (\"[^\n]*\") \})", text):
        if match.group(1):
            members[match.group(1)] = match.group(2)
        else:
            members[match.group(3)] = match.group(4) + " => " + match.group(5)
    return members


if not ui_axid_path.exists():
    fail("App/GarderobeUITests/AXID.swift is missing")
else:
    a, b = axid_members(kit_axid), axid_members(ui_axid_path.read_text())
    if not a:
        fail("no identifiers found in AccessibilityIdentifiers.swift")
    for name in sorted(set(a) | set(b)):
        if a.get(name) != b.get(name):
            fail(f"AXID.{name} differs between GarderobeKit and the UI tests: {a.get(name)} vs {b.get(name)}")

# 2-4. Source rules
sources = sorted(p for p in app.rglob("*.swift"))
app_sources = [p for p in sources if "/Garderobe/" in p.as_posix()]
direct_api_allowed = {
    # Read-only list with no model of its own (lifecycle projects are worked on in Conversation).
    "App/Garderobe/Screens/Returns/ProjectsScreen.swift",
}
types = {}
for path in sources:
    rel = path.relative_to(ios).as_posix()
    text = path.read_text()
    code = re.sub(r"//[^\n]*", "", text)
    target = rel.split("/")[1]
    for match in re.finditer(r"^(?:@MainActor\s+)?(?:final\s+)?(?:public\s+|private\s+|fileprivate\s+)?(struct|class|enum)\s+(\w+)", code, re.M):
        if "private " in match.group(0):
            continue
        types.setdefault((target, match.group(2)), []).append(rel)
    if path in app_sources:
        if re.search(r"\bCommandDraft\(|\.center\.submit\(|\bCommand[A-Z]\w+\(", code) and "/Design/" not in rel:
            fail(f"{rel}: builds or submits a command directly; commands belong to the feature models")
        if re.search(r"environment\.api\.\w+\(", code) and rel not in direct_api_allowed:
            fail(f"{rel}: calls the API directly; reads belong to the feature models")
    lowered = code.lower()
    for banned, why in [("todo", "placeholder"), ("coming soon", "placeholder"), ("lorem ipsum", "placeholder"), ("new chat", "the conversation has no new-chat action"),
                        ("streak", "no streaks"), ("#preview", "previews with invented data are not allowed")]:
        if path not in app_sources and "GarderobeShare" not in rel:
            continue  # the UI tests name banned wording in order to assert it is absent
        if re.search(r"\b" + re.escape(banned) + r"\b" if banned[0].isalpha() else re.escape(banned), lowered):
            fail(f"{rel}: contains '{banned}' ({why})")

for (target, name), where in sorted(types.items()):
    if len(where) > 1:
        fail(f"type {name} is declared more than once in target {target}: {', '.join(where)}")

root = (app / "Garderobe/GarderobeApp.swift").read_text()
expected = set(re.findall(r"\b([A-Z]\w+(?:Screen|Sheet|Flow|View))\(", root)) - {"RootView", "StatusBannerView", "UndoBannerView", "TabView", "NavigationView", "ScrollView"}
for name in sorted(expected):
    if ("Garderobe", name) not in types:
        fail(f"GarderobeApp.swift uses {name}, which no file in App/Garderobe declares")
if ("GarderobeShare", "ShareViewController") not in types:
    fail("the share extension's principal class ShareViewController is missing")

if failures:
    print(f"{len(failures)} problem(s) in ios/App:")
    for line in failures:
        print("  -", line)
    sys.exit(1)
print(f"app sources ok: {len(sources)} files, {len(types)} top-level types, {len(expected)} root views resolved, AXID copy identical")
