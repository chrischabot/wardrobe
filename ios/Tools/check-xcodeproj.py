#!/usr/bin/env python3
"""Structural verifier for ios/Garderobe.xcodeproj.

    python3 ios/Tools/check-xcodeproj.py

Prints one line per check and exits non-zero when any check fails. Paths are
resolved relative to this script; only the Python standard library is used.

This proves that the project file is internally consistent and that everything
it points at exists. It does not prove that Xcode opens or builds the project:
that needs a Mac.
"""

from __future__ import annotations

import json
import plistlib
import re
import sys
import xml.etree.ElementTree as ElementTree
from pathlib import Path

IOS_DIR = Path(__file__).resolve().parent.parent
PROJECT_NAME = "Garderobe"
PROJECT_DIR = IOS_DIR / f"{PROJECT_NAME}.xcodeproj"
PBXPROJ = PROJECT_DIR / "project.pbxproj"
SCHEME = PROJECT_DIR / "xcshareddata" / "xcschemes" / f"{PROJECT_NAME}.xcscheme"
PROJECT_CONTAINER = f"container:{PROJECT_NAME}.xcodeproj"

APP = "Garderobe"
SHARE = "GarderobeShare"
UI_TESTS = "GarderobeUITests"
EXPECTED_PRODUCT_TYPES = {
    APP: "com.apple.product-type.application",
    SHARE: "com.apple.product-type.app-extension",
    UI_TESTS: "com.apple.product-type.bundle.ui-testing",
}
PACKAGE_PRODUCT = "GarderobeKit"
PACKAGE_TEST_TARGET = "GarderobeKitTests"
CONFIGURATION_NAMES = ["Debug", "Release"]

# Settings Config/Base.xcconfig must define (an empty value still counts).
REQUIRED_BASE_SETTINGS = [
    "IPHONEOS_DEPLOYMENT_TARGET",
    "SDKROOT",
    "TARGETED_DEVICE_FAMILY",
    "SWIFT_VERSION",
    "MARKETING_VERSION",
    "CURRENT_PROJECT_VERSION",
    "GARDEROBE_BUNDLE_ID_PREFIX",
    "GARDEROBE_APP_GROUP",
    "GARDEROBE_KEYCHAIN_GROUP",
    "DEVELOPMENT_TEAM",
    "CODE_SIGN_STYLE",
    "GARDEROBE_API_BASE_URL",
    "GARDEROBE_OAUTH_CLIENT_ID",
    "GARDEROBE_OAUTH_REDIRECT_URL",
    "GARDEROBE_ASSOCIATED_DOMAIN",
]

OBJECT_ID = re.compile(r"\A[0-9A-F]{24}\Z")


# ---------------------------------------------------------------------------
# OpenStep (ASCII) property list parser
# ---------------------------------------------------------------------------


class PlistSyntaxError(Exception):
    pass


class OpenStepParser:
    """Parses the subset of the OpenStep plist format that Xcode writes:
    dictionaries, arrays, quoted and unquoted strings, and both comment forms.
    Dictionaries become dict, arrays list, strings str. A repeated dictionary
    key is an error."""

    _UNQUOTED = frozenset(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$./:-"
    )
    _ESCAPES = {
        "n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "f": "\f",
        "v": "\v", '"': '"', "'": "'", "\\": "\\", "\n": "\n",
    }

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def fail(self, message: str) -> PlistSyntaxError:
        line = self.text.count("\n", 0, self.pos) + 1
        column = self.pos - (self.text.rfind("\n", 0, self.pos) + 1) + 1
        return PlistSyntaxError(f"line {line}, column {column}: {message}")

    def skip(self) -> None:
        text, length = self.text, len(self.text)
        while self.pos < length:
            char = text[self.pos]
            if char in " \t\r\n":
                self.pos += 1
            elif text.startswith("/*", self.pos):
                end = text.find("*/", self.pos + 2)
                if end < 0:
                    raise self.fail("comment is never closed")
                self.pos = end + 2
            elif text.startswith("//", self.pos):
                end = text.find("\n", self.pos)
                self.pos = length if end < 0 else end + 1
            else:
                return

    def expect(self, char: str) -> None:
        self.skip()
        if not self.text.startswith(char, self.pos):
            found = self.text[self.pos : self.pos + 1] or "end of file"
            raise self.fail(f"expected {char!r}, found {found!r}")
        self.pos += 1

    def peek(self) -> str:
        self.skip()
        return self.text[self.pos : self.pos + 1]

    def parse(self) -> object:
        value = self.value()
        self.skip()
        if self.pos != len(self.text):
            raise self.fail("unexpected content after the top-level value")
        return value

    def value(self) -> object:
        char = self.peek()
        if char == "{":
            return self.dictionary()
        if char == "(":
            return self.array()
        if char == '"':
            return self.quoted()
        if char == "":
            raise self.fail("unexpected end of file")
        return self.unquoted()

    def dictionary(self) -> dict:
        self.expect("{")
        result: dict = {}
        while True:
            if self.peek() == "}":
                self.pos += 1
                return result
            key = self.quoted() if self.peek() == '"' else self.unquoted()
            self.expect("=")
            value = self.value()
            self.expect(";")
            if key in result:
                raise self.fail(f"dictionary key {key!r} appears twice")
            result[key] = value

    def array(self) -> list:
        self.expect("(")
        result: list = []
        while True:
            if self.peek() == ")":
                self.pos += 1
                return result
            result.append(self.value())
            if self.peek() == ",":
                self.pos += 1
            elif self.peek() != ")":
                raise self.fail("expected ',' or ')' in array")

    def quoted(self) -> str:
        self.expect('"')
        text, out = self.text, []
        while True:
            if self.pos >= len(text):
                raise self.fail("string is never closed")
            char = text[self.pos]
            self.pos += 1
            if char == '"':
                return "".join(out)
            if char != "\\":
                out.append(char)
                continue
            if self.pos >= len(text):
                raise self.fail("string ends in a backslash")
            escape = text[self.pos]
            self.pos += 1
            if escape == "U":
                digits = text[self.pos : self.pos + 4]
                if not re.fullmatch(r"[0-9A-Fa-f]{4}", digits):
                    raise self.fail("\\U must be followed by four hex digits")
                out.append(chr(int(digits, 16)))
                self.pos += 4
            elif escape in self._ESCAPES:
                out.append(self._ESCAPES[escape])
            else:
                raise self.fail(f"unknown escape \\{escape}")

    def unquoted(self) -> str:
        self.skip()
        text, start = self.text, self.pos
        while self.pos < len(text) and text[self.pos] in self._UNQUOTED:
            # A slash that opens a comment ends the string.
            if text.startswith(("/*", "//"), self.pos):
                break
            self.pos += 1
        if self.pos == start:
            raise self.fail(f"unexpected character {text[start:start + 1]!r}")
        return text[start : self.pos]


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


class Report:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def check(self, description: str, problems: object = None) -> bool:
        """Record one check. `problems` is falsy for a pass; otherwise a string
        or a list of strings saying what is wrong."""
        if not problems:
            self.passed += 1
            print(f"ok    {description}")
            return True
        self.failed += 1
        if isinstance(problems, str):
            problems = [problems]
        print(f"FAIL  {description}: " + "; ".join(str(p) for p in problems))
        return False

    def guarded(self, description: str, function) -> bool:
        """Run a check function that returns its problems; a missing key or a
        wrong type inside it is a failure of that check, not a crash."""
        try:
            problems = function()
        except Exception as error:  # noqa: BLE001 - reported, never hidden
            problems = f"{type(error).__name__}: {error}"
        return self.check(description, problems)


def relative(path: Path) -> str:
    try:
        return str(path.relative_to(IOS_DIR))
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# Project model helpers
# ---------------------------------------------------------------------------


class Project:
    def __init__(self, root: dict) -> None:
        self.root = root
        self.objects: dict = root["objects"]
        self.project: dict = self.objects[root["rootObject"]]
        self.targets: dict[str, tuple[str, dict]] = {}
        for identifier in self.project.get("targets", []):
            target = self.objects.get(identifier, {})
            self.targets[target.get("name", identifier)] = (identifier, target)
        # Parent group of every group child, to rebuild on-disk paths.
        self.parents: dict[str, str] = {}
        for identifier, obj in self.objects.items():
            if obj.get("isa") == "PBXGroup":
                for child in obj.get("children", []):
                    self.parents[child] = identifier

    def of_class(self, isa: str) -> dict:
        return {i: o for i, o in self.objects.items() if o.get("isa") == isa}

    def disk_path(self, identifier: str) -> Path:
        """On-disk location of a group or file reference."""
        obj = self.objects[identifier]
        tree = obj.get("sourceTree")
        path = obj.get("path")
        if tree == "SOURCE_ROOT":
            return IOS_DIR / path if path else IOS_DIR
        if tree == "<absolute>":
            return Path(path)
        if tree != "<group>":
            raise ValueError(f"{identifier} has no on-disk location (sourceTree {tree})")
        parent = self.parents.get(identifier)
        base = self.disk_path(parent) if parent else IOS_DIR
        return base / path if path else base

    def configurations(self, owner: dict) -> dict[str, dict]:
        configuration_list = self.objects[owner["buildConfigurationList"]]
        return {
            self.objects[i]["name"]: self.objects[i]
            for i in configuration_list["buildConfigurations"]
        }

    def phases(self, target: dict, isa: str) -> list[dict]:
        return [
            self.objects[i]
            for i in target.get("buildPhases", [])
            if self.objects[i].get("isa") == isa
        ]


def walk_strings(value: object):
    """Every string in a parsed plist value, dictionary keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from walk_strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from walk_strings(item)


def load_xml_plist(path: Path) -> object:
    with path.open("rb") as handle:
        return plistlib.load(handle, fmt=plistlib.FMT_XML)


# ---------------------------------------------------------------------------
# xcconfig
# ---------------------------------------------------------------------------

_INCLUDE = re.compile(r'\A#include(\?)?\s+"([^"]+)"\s*\Z')
_ASSIGNMENT = re.compile(r"\A([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])*\s*=\s*(.*)\Z")


def read_xcconfig(path: Path, problems: list[str], seen: tuple[Path, ...] = ()) -> dict:
    """Settings defined by an xcconfig file and everything it includes.
    Unresolved or circular includes and unreadable lines go into `problems`."""
    settings: dict[str, str] = {}
    if path in seen:
        problems.append(f"{relative(path)} includes itself")
        return settings
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        include = _INCLUDE.match(line)
        if include:
            optional, name = include.group(1), include.group(2)
            included = (path.parent / name).resolve()
            if included.is_file():
                settings.update(read_xcconfig(included, problems, seen + (path,)))
            elif not optional:
                problems.append(f'{relative(path)}:{number} #include "{name}" not found')
            continue
        assignment = _ASSIGNMENT.match(line)
        if assignment:
            settings[assignment.group(1)] = assignment.group(3).strip()
        else:
            problems.append(f"{relative(path)}:{number} is not a setting or include")
    return settings


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check_sections(text: str, objects: dict) -> list[str]:
    """The section banners Xcode writes: balanced, in class-name order, and
    each object listed inside the banner of its own class."""
    problems: list[str] = []
    if not text.startswith("// !$*UTF8*$!\n"):
        problems.append("file does not start with the // !$*UTF8*$! header")
    order: list[str] = []
    current = None
    for line in text.splitlines():
        begin = re.fullmatch(r"/\* Begin (\w+) section \*/", line)
        end = re.fullmatch(r"/\* End (\w+) section \*/", line)
        if begin:
            if current:
                problems.append(f"section {begin.group(1)} begins inside {current}")
            current = begin.group(1)
            order.append(current)
        elif end:
            if end.group(1) != current:
                problems.append(f"section {end.group(1)} ends but {current} is open")
            current = None
        else:
            entry = re.match(r"\t\t([0-9A-F]{24})(?: /\*.*?\*/)? = \{", line)
            if entry:
                isa = objects.get(entry.group(1), {}).get("isa")
                if current is None:
                    problems.append(f"object {entry.group(1)} is outside any section")
                elif isa != current:
                    problems.append(f"object {entry.group(1)} ({isa}) is in section {current}")
    if current:
        problems.append(f"section {current} is never closed")
    if order != sorted(order):
        problems.append("sections are not in class-name order")
    if len(order) != len(set(order)):
        problems.append("a section appears twice")
    missing = {o.get("isa") for o in objects.values()} - set(order)
    if missing:
        problems.append(f"no section for {sorted(str(m) for m in missing)}")
    return problems


def check_references(root: dict) -> list[str]:
    objects = root["objects"]
    problems = []
    for identifier in objects:
        if not OBJECT_ID.match(identifier):
            problems.append(f"object key {identifier!r} is not 24 uppercase hex characters")
    for owner, obj in objects.items():
        if not isinstance(obj, dict) or "isa" not in obj:
            problems.append(f"object {owner} has no isa")
            continue
        for string in walk_strings(obj):
            if OBJECT_ID.match(string) and string not in objects:
                problems.append(f"{owner} ({obj['isa']}) refers to missing object {string}")
    if root.get("rootObject") not in objects:
        problems.append(f"rootObject {root.get('rootObject')} is not an object")
    return problems


def run(report: Report) -> None:
    # --- parse ---------------------------------------------------------------
    if not report.check(
        f"{relative(PBXPROJ)} exists", None if PBXPROJ.is_file() else "file not found"
    ):
        return
    text = PBXPROJ.read_text(encoding="utf-8")
    try:
        root = OpenStepParser(text).parse()
        parse_problem = None if isinstance(root, dict) else "top level is not a dictionary"
    except PlistSyntaxError as error:
        root, parse_problem = None, str(error)
    if not report.check("project.pbxproj parses as an OpenStep property list", parse_problem):
        return

    report.guarded(
        "top level has archiveVersion 1, objectVersion 77, classes, objects, rootObject",
        lambda: [
            f"{key} is {root.get(key)!r}"
            for key, wanted in (("archiveVersion", "1"), ("objectVersion", "77"), ("classes", {}))
            if root.get(key) != wanted
        ]
        + [f"{key} missing" for key in ("objects", "rootObject") if key not in root],
    )
    if not isinstance(root.get("objects"), dict):
        return
    objects = root["objects"]

    report.guarded(
        f"every 24-hex object reference resolves ({len(objects)} objects)",
        lambda: check_references(root),
    )
    report.guarded(
        "section banners are balanced, ordered and hold objects of their class",
        lambda: check_sections(text, objects),
    )
    if not report.guarded(
        "rootObject is a PBXProject",
        lambda: None
        if objects[root["rootObject"]].get("isa") == "PBXProject"
        else f"isa is {objects[root['rootObject']].get('isa')!r}",
    ):
        return

    project = Project(root)

    # --- targets ---------------------------------------------------------------
    for name, product_type in EXPECTED_PRODUCT_TYPES.items():
        def target_type(name=name, product_type=product_type):
            if name not in project.targets:
                return f"no target named {name} (found {sorted(project.targets)})"
            _, target = project.targets[name]
            problems = []
            if target.get("isa") != "PBXNativeTarget":
                problems.append(f"isa is {target.get('isa')!r}")
            if target.get("productType") != product_type:
                problems.append(f"productType is {target.get('productType')!r}")
            product = objects[target["productReference"]]
            if product.get("sourceTree") != "BUILT_PRODUCTS_DIR":
                problems.append("product reference is not in BUILT_PRODUCTS_DIR")
            return problems

        report.guarded(f"target {name} exists with productType {product_type}", target_type)
    if any(name not in project.targets for name in EXPECTED_PRODUCT_TYPES):
        return

    # --- build configurations and xcconfig files --------------------------------
    xcconfig_files: set[Path] = set()

    def configurations_ok(owner: dict):
        problems = []
        configurations = project.configurations(owner)
        if sorted(configurations) != CONFIGURATION_NAMES:
            problems.append(f"configurations are {sorted(configurations)}")
        for name, configuration in configurations.items():
            reference = configuration.get("baseConfigurationReference")
            if not reference:
                problems.append(f"{name} has no baseConfigurationReference")
                continue
            path = project.disk_path(reference)
            if not path.is_file():
                problems.append(f"{name} base configuration {relative(path)} not found")
                continue
            if path.name != f"{name}.xcconfig":
                problems.append(f"{name} is based on {path.name}")
            xcconfig_files.add(path)
        return problems

    report.guarded(
        "project has Debug and Release configurations based on existing xcconfig files",
        lambda: configurations_ok(project.project),
    )
    for name in EXPECTED_PRODUCT_TYPES:
        report.guarded(
            f"target {name} has Debug and Release configurations based on existing xcconfig files",
            lambda name=name: configurations_ok(project.targets[name][1]),
        )

    # --- synchronized folders ------------------------------------------------
    def synchronized_folder(name: str):
        identifier, target = project.targets[name]
        groups = target.get("fileSystemSynchronizedGroups", [])
        if len(groups) != 1:
            return f"expected one synchronized group, found {len(groups)}"
        group = objects[groups[0]]
        problems = []
        if group.get("isa") != "PBXFileSystemSynchronizedRootGroup":
            return f"group isa is {group.get('isa')!r}"
        folder = project.disk_path(groups[0])
        if folder != IOS_DIR / "App" / name:
            problems.append(f"folder is {relative(folder)}, expected App/{name}")
        if not folder.is_dir():
            problems.append(f"folder {relative(folder)} not found")
        for exception_id in group.get("exceptions", []):
            exception = objects[exception_id]
            if exception.get("isa") != "PBXFileSystemSynchronizedBuildFileExceptionSet":
                problems.append(f"exception {exception_id} isa is {exception.get('isa')!r}")
            if objects.get(exception.get("target"), {}).get("isa") != "PBXNativeTarget":
                problems.append(f"exception {exception_id} target is not a native target")
            for entry in exception.get("membershipExceptions", []):
                if not (folder / entry).is_file():
                    problems.append(f"membership exception {relative(folder / entry)} not found")
        return problems

    for name in EXPECTED_PRODUCT_TYPES:
        report.guarded(
            f"target {name} is attached to synchronized folder App/{name}; "
            "the folder and its membership exceptions exist",
            lambda name=name: synchronized_folder(name),
        )

    def no_orphan_folders():
        attached = {
            group
            for _, target in project.targets.values()
            for group in target.get("fileSystemSynchronizedGroups", [])
        }
        return [
            f"{identifier} ({group.get('path')}) is attached to no target"
            for identifier, group in project.of_class("PBXFileSystemSynchronizedRootGroup").items()
            if identifier not in attached
        ]

    report.guarded("every synchronized root group is attached to a target", no_orphan_folders)

    # --- Info.plist and entitlements -----------------------------------------
    def setting_files(name: str, setting: str, required: bool):
        problems = []
        target_id, target = project.targets[name]
        folder = project.disk_path(target["fileSystemSynchronizedGroups"][0])
        excluded = {
            folder / entry
            for group_id in target["fileSystemSynchronizedGroups"]
            for exception_id in objects[group_id].get("exceptions", [])
            if objects[exception_id].get("target") == target_id
            for entry in objects[exception_id].get("membershipExceptions", [])
        }
        for configuration_name, configuration in project.configurations(target).items():
            value = configuration["buildSettings"].get(setting)
            if value is None:
                if required:
                    problems.append(f"{configuration_name} does not set {setting}")
                continue
            path = IOS_DIR / value
            if not path.is_file():
                problems.append(f"{configuration_name} {setting} {value} not found")
                continue
            try:
                if not isinstance(load_xml_plist(path), dict):
                    problems.append(f"{value} is not a dictionary")
            except Exception as error:  # noqa: BLE001
                problems.append(f"{value} is not an XML property list: {error}")
            if path not in excluded:
                problems.append(
                    f"{value} is inside the synchronized folder but not a membership exception"
                )
        return problems

    for name in (APP, SHARE):
        for setting in ("INFOPLIST_FILE", "CODE_SIGN_ENTITLEMENTS"):
            report.guarded(
                f"target {name} {setting} exists, is an XML plist and is a membership exception",
                lambda name=name, setting=setting: setting_files(name, setting, True),
            )
    report.guarded(
        f"target {UI_TESTS} has no Info.plist file and generates one",
        lambda: [
            f"{configuration_name}: INFOPLIST_FILE={settings.get('INFOPLIST_FILE')!r} "
            f"GENERATE_INFOPLIST_FILE={settings.get('GENERATE_INFOPLIST_FILE')!r}"
            for configuration_name, configuration in project.configurations(
                project.targets[UI_TESTS][1]
            ).items()
            for settings in [configuration["buildSettings"]]
            if "INFOPLIST_FILE" in settings or settings.get("GENERATE_INFOPLIST_FILE") != "YES"
        ],
    )

    # --- target relationships ---------------------------------------------------
    app_id, app = project.targets[APP]
    share_id, share = project.targets[SHARE]
    tests_id, tests = project.targets[UI_TESTS]

    def depends_on(target: dict, dependency_id: str):
        for identifier in target.get("dependencies", []):
            dependency = objects[identifier]
            proxy = objects[dependency["targetProxy"]]
            if (
                dependency.get("target") == dependency_id
                and proxy.get("remoteGlobalIDString") == dependency_id
                and proxy.get("containerPortal") == root["rootObject"]
                and proxy.get("proxyType") == "1"
            ):
                return None
        return "no PBXTargetDependency with a matching PBXContainerItemProxy"

    def embeds_extension():
        for phase in project.phases(app, "PBXCopyFilesBuildPhase"):
            if phase.get("dstSubfolderSpec") != "13":
                continue
            for identifier in phase.get("files", []):
                if objects[identifier].get("fileRef") == share["productReference"]:
                    return None
        return "no copy-files phase with dstSubfolderSpec 13 contains GarderobeShare.appex"

    report.guarded(f"{APP} embeds {SHARE}.appex (copy files, dstSubfolderSpec 13)", embeds_extension)
    report.guarded(f"{APP} has a target dependency on {SHARE}", lambda: depends_on(app, share_id))
    report.guarded(f"{UI_TESTS} has a target dependency on {APP}", lambda: depends_on(tests, app_id))
    report.guarded(
        f"{UI_TESTS} tests {APP} (TEST_TARGET_NAME and TestTargetID)",
        lambda: [
            f"{configuration_name} TEST_TARGET_NAME is "
            f"{configuration['buildSettings'].get('TEST_TARGET_NAME')!r}"
            for configuration_name, configuration in project.configurations(tests).items()
            if configuration["buildSettings"].get("TEST_TARGET_NAME") != APP
        ]
        + (
            []
            if project.project["attributes"]["TargetAttributes"][tests_id].get("TestTargetID")
            == app_id
            else ["TargetAttributes TestTargetID is not the app target"]
        ),
    )

    # --- Swift package ------------------------------------------------------------
    def links_package(target: dict):
        dependencies = [
            identifier
            for identifier in target.get("packageProductDependencies", [])
            if objects[identifier].get("isa") == "XCSwiftPackageProductDependency"
            and objects[identifier].get("productName") == PACKAGE_PRODUCT
        ]
        if not dependencies:
            return f"packageProductDependencies has no {PACKAGE_PRODUCT} product"
        for phase in project.phases(target, "PBXFrameworksBuildPhase"):
            for identifier in phase.get("files", []):
                if objects[identifier].get("productRef") in dependencies:
                    return None
        return f"Frameworks phase has no build file whose productRef is {PACKAGE_PRODUCT}"

    report.guarded(f"{APP} links package product {PACKAGE_PRODUCT}", lambda: links_package(app))
    report.guarded(f"{SHARE} links package product {PACKAGE_PRODUCT}", lambda: links_package(share))

    package_dirs: list[Path] = []

    def local_package():
        references = project.project.get("packageReferences", [])
        if not references:
            return "project has no packageReferences"
        problems = []
        for identifier in references:
            reference = objects[identifier]
            if reference.get("isa") != "XCLocalSwiftPackageReference":
                problems.append(f"{identifier} isa is {reference.get('isa')!r}")
                continue
            directory = IOS_DIR / reference["relativePath"]
            manifest = directory / "Package.swift"
            if not manifest.is_file():
                problems.append(f"{relative(manifest)} not found")
                continue
            package_dirs.append(directory)
        manifests = "".join(
            (d / "Package.swift").read_text(encoding="utf-8") for d in package_dirs
        )
        if not re.search(r'\.library\(\s*name:\s*"%s"' % re.escape(PACKAGE_PRODUCT), manifests):
            problems.append(f"no local package declares a library product {PACKAGE_PRODUCT}")
        return problems

    report.guarded(
        f"local package relativePath contains a Package.swift that declares library {PACKAGE_PRODUCT}",
        local_package,
    )

    # --- scheme -------------------------------------------------------------------
    scheme = None

    def scheme_parses():
        nonlocal scheme
        if not SCHEME.is_file():
            return "file not found"
        try:
            scheme = ElementTree.parse(SCHEME).getroot()
        except ElementTree.ParseError as error:
            return str(error)
        return None if scheme.tag == "Scheme" else f"root element is {scheme.tag}"

    target_ids = {identifier: name for name, (identifier, _) in project.targets.items()}

    def scheme_references():
        problems = []
        references = list(scheme.iter("BuildableReference"))
        if not references:
            return "scheme has no BuildableReference"
        for reference in references:
            container = reference.get("ReferencedContainer", "")
            blueprint = reference.get("BlueprintIdentifier", "")
            if container == PROJECT_CONTAINER:
                name = target_ids.get(blueprint)
                if name is None:
                    problems.append(f"BlueprintIdentifier {blueprint} is not a target")
                    continue
                target = project.targets[name][1]
                product = objects[target["productReference"]].get("path")
                if reference.get("BlueprintName") != name:
                    problems.append(f"{blueprint} BlueprintName is {reference.get('BlueprintName')}")
                if reference.get("BuildableName") != product:
                    problems.append(f"{blueprint} BuildableName is {reference.get('BuildableName')}")
            elif container.startswith("container:"):
                directory = IOS_DIR / container[len("container:"):]
                manifest = directory / "Package.swift"
                if not manifest.is_file():
                    problems.append(f"{container} has no Package.swift")
                elif not re.search(
                    r'\.testTarget\(\s*name:\s*"%s"' % re.escape(blueprint),
                    manifest.read_text(encoding="utf-8"),
                ):
                    problems.append(f"{relative(manifest)} has no test target {blueprint}")
                names = {reference.get("BuildableName"), reference.get("BlueprintName"), blueprint}
                if len(names) != 1:
                    problems.append(f"package reference names disagree: {sorted(map(str, names))}")
            else:
                problems.append(f"unexpected ReferencedContainer {container!r}")
        return problems

    def blueprints(path: str) -> list[str]:
        return [r.get("BlueprintIdentifier") for r in scheme.findall(path)]

    def scheme_actions():
        problems = []
        if blueprints("BuildAction/BuildActionEntries/BuildActionEntry/BuildableReference") != [app_id]:
            problems.append("BuildAction does not build exactly the app")
        testables = blueprints("TestAction/Testables/TestableReference/BuildableReference")
        if sorted(testables) != sorted([tests_id, PACKAGE_TEST_TARGET]):
            problems.append(f"TestAction testables are {testables}")
        for action in ("LaunchAction", "ProfileAction"):
            if blueprints(f"{action}/BuildableProductRunnable/BuildableReference") != [app_id]:
                problems.append(f"{action} does not run the app")
        configuration_names = set(CONFIGURATION_NAMES)
        for action in ("TestAction", "LaunchAction", "ProfileAction", "AnalyzeAction", "ArchiveAction"):
            element = scheme.find(action)
            if element is None:
                problems.append(f"{action} missing")
            elif element.get("buildConfiguration") not in configuration_names:
                problems.append(f"{action} uses configuration {element.get('buildConfiguration')!r}")
        return problems

    if report.guarded(f"{relative(SCHEME)} is well-formed XML", scheme_parses):
        report.guarded(
            "every scheme BuildableReference resolves (project targets by ID, package test target by name)",
            scheme_references,
        )
        report.guarded(
            f"scheme builds, runs, profiles and archives {APP} and tests "
            f"{UI_TESTS} and {PACKAGE_TEST_TARGET}",
            scheme_actions,
        )

    # --- xcconfig -------------------------------------------------------------------
    settings_by_file: dict[Path, dict] = {}

    def includes_resolve():
        problems: list[str] = []
        if not xcconfig_files:
            return "no xcconfig file is referenced by the project"
        for path in sorted(xcconfig_files):
            settings_by_file[path] = read_xcconfig(path, problems)
        return problems

    report.guarded("every xcconfig #include resolves and every line parses", includes_resolve)
    report.guarded(
        "Debug.xcconfig and Release.xcconfig define every required base setting",
        lambda: [
            f"{path.name} does not define {name}"
            for path, settings in sorted(settings_by_file.items())
            for name in REQUIRED_BASE_SETTINGS
            if name not in settings
        ]
        or (None if settings_by_file else "no xcconfig settings were read"),
    )

    # --- property lists and their build-setting variables -------------------------
    def plist_of(name: str, setting: str) -> dict:
        configuration = project.configurations(project.targets[name][1])["Debug"]
        return load_xml_plist(IOS_DIR / configuration["buildSettings"][setting])

    def app_info_plist():
        plist = plist_of(APP, "INFOPLIST_FILE")
        expected = {
            "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)",
            "CFBundleShortVersionString": "$(MARKETING_VERSION)",
            "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
            "UILaunchScreen": {},
            "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": False},
            "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
            "GarderobeAPIBaseURL": "$(GARDEROBE_API_BASE_URL)",
            "GarderobeOAuthClientID": "$(GARDEROBE_OAUTH_CLIENT_ID)",
            "GarderobeOAuthRedirectURL": "$(GARDEROBE_OAUTH_REDIRECT_URL)",
            "GarderobeAppGroup": "$(GARDEROBE_APP_GROUP)",
            "GarderobeKeychainGroup": "$(GARDEROBE_KEYCHAIN_GROUP)",
            "ITSAppUsesNonExemptEncryption": False,
        }
        problems = [
            f"{key} is {plist.get(key)!r}" for key, value in expected.items() if plist.get(key) != value
        ]
        for key in ("NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"):
            if not plist.get(key):
                problems.append(f"{key} missing")
        if "UIBackgroundModes" in plist:
            problems.append("UIBackgroundModes must not be declared")
        return problems

    def share_info_plist():
        plist = plist_of(SHARE, "INFOPLIST_FILE")
        expected = {
            "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)",
            "GarderobeAPIBaseURL": "$(GARDEROBE_API_BASE_URL)",
            "GarderobeOAuthClientID": "$(GARDEROBE_OAUTH_CLIENT_ID)",
            "GarderobeAppGroup": "$(GARDEROBE_APP_GROUP)",
            "GarderobeKeychainGroup": "$(GARDEROBE_KEYCHAIN_GROUP)",
            "NSExtension": {
                "NSExtensionAttributes": {
                    "NSExtensionActivationRule": {
                        "NSExtensionActivationSupportsWebURLWithMaxCount": 1,
                        "NSExtensionActivationSupportsWebPageWithMaxCount": 1,
                    }
                },
                "NSExtensionPointIdentifier": "com.apple.share-services",
                "NSExtensionPrincipalClass": "$(PRODUCT_MODULE_NAME).ShareViewController",
            },
        }
        return [
            f"{key} is {plist.get(key)!r}" for key, value in expected.items() if plist.get(key) != value
        ]

    def entitlements():
        groups = {
            "com.apple.security.application-groups": ["$(GARDEROBE_APP_GROUP)"],
            "keychain-access-groups": ["$(GARDEROBE_KEYCHAIN_GROUP)"],
        }
        domains = {
            "com.apple.developer.associated-domains": [
                "applinks:$(GARDEROBE_ASSOCIATED_DOMAIN)",
                "webcredentials:$(GARDEROBE_ASSOCIATED_DOMAIN)",
            ]
        }
        problems = []
        for name, expected in ((APP, {**groups, **domains}), (SHARE, groups)):
            plist = plist_of(name, "CODE_SIGN_ENTITLEMENTS")
            if plist != expected:
                problems.append(f"{name} entitlements are {plist!r}")
        return problems

    report.guarded(f"{APP} Info.plist has the required keys and no UIBackgroundModes", app_info_plist)
    report.guarded(f"{SHARE} Info.plist declares the share extension and its configuration keys", share_info_plist)
    report.guarded("entitlements declare the app group, keychain group and (app only) associated domains", entitlements)

    privacy = IOS_DIR / "App" / APP / "PrivacyInfo.xcprivacy"

    def privacy_manifest():
        plist = load_xml_plist(privacy)
        problems = []
        if plist.get("NSPrivacyTracking") is not False:
            problems.append("NSPrivacyTracking is not false")
        if plist.get("NSPrivacyTrackingDomains") != []:
            problems.append("NSPrivacyTrackingDomains is not empty")
        reasons = {
            entry.get("NSPrivacyAccessedAPIType"): entry.get("NSPrivacyAccessedAPITypeReasons")
            for entry in plist.get("NSPrivacyAccessedAPITypes", [])
        }
        if reasons != {
            "NSPrivacyAccessedAPICategoryUserDefaults": ["CA92.1"],
            "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
        }:
            problems.append(f"accessed API types are {reasons!r}")
        collected = {}
        for entry in plist.get("NSPrivacyCollectedDataTypes", []):
            collected[entry.get("NSPrivacyCollectedDataType")] = (
                entry.get("NSPrivacyCollectedDataTypeLinked"),
                entry.get("NSPrivacyCollectedDataTypeTracking"),
                entry.get("NSPrivacyCollectedDataTypePurposes"),
            )
        wanted = (True, False, ["NSPrivacyCollectedDataTypePurposeAppFunctionality"])
        if collected != {
            "NSPrivacyCollectedDataTypePhotosorVideos": wanted,
            "NSPrivacyCollectedDataTypeOtherUserContent": wanted,
        }:
            problems.append(f"collected data types are {collected!r}")
        return problems

    report.guarded(
        f"{relative(privacy)} is an XML plist with the declared API reasons and data types",
        privacy_manifest,
    )

    def variables_defined():
        """Every $(GARDEROBE_*) used by the project, plists or entitlements is
        defined by both configurations' xcconfig files."""
        sources = [PBXPROJ, privacy]
        for name in (APP, SHARE):
            for configuration in project.configurations(project.targets[name][1]).values():
                for setting in ("INFOPLIST_FILE", "CODE_SIGN_ENTITLEMENTS"):
                    sources.append(IOS_DIR / configuration["buildSettings"][setting])
        used: dict[str, str] = {}
        for path in sources:
            for name in re.findall(r"\$\((GARDEROBE_[A-Z0-9_]+)\)", path.read_text(encoding="utf-8")):
                used.setdefault(name, relative(path))
        if not used:
            return "no $(GARDEROBE_*) variable is used anywhere"
        return [
            f"$({name}) used in {where} is not defined in {path.name}"
            for name, where in sorted(used.items())
            for path, settings in sorted(settings_by_file.items())
            if name not in settings
        ]

    report.guarded(
        "every $(GARDEROBE_*) variable used in the project, plists and entitlements is defined in xcconfig",
        variables_defined,
    )

    # --- asset catalog ----------------------------------------------------------------
    catalog = IOS_DIR / "App" / APP / "Assets.xcassets"
    contents: dict[Path, object] = {}

    def catalog_json():
        files = sorted(catalog.rglob("Contents.json"))
        if catalog / "Contents.json" not in files:
            return f"{relative(catalog / 'Contents.json')} not found"
        problems = []
        for path in files:
            try:
                contents[path] = json.loads(path.read_text(encoding="utf-8"))
            except ValueError as error:
                problems.append(f"{relative(path)}: {error}")
        return problems

    def catalog_names():
        problems = []
        app_settings = project.configurations(app)
        for configuration_name, configuration in app_settings.items():
            settings = configuration["buildSettings"]
            for setting, suffix in (
                ("ASSETCATALOG_COMPILER_APPICON_NAME", ".appiconset"),
                ("ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME", ".colorset"),
            ):
                value = settings.get(setting)
                if not value:
                    problems.append(f"{configuration_name} does not set {setting}")
                elif catalog / f"{value}{suffix}" / "Contents.json" not in contents:
                    problems.append(f"{configuration_name} {setting}={value} has no {value}{suffix}")
        for path, data in contents.items():
            for image in data.get("images", []) if isinstance(data, dict) else []:
                filename = image.get("filename")
                if filename and not (path.parent / filename).is_file():
                    problems.append(f"{relative(path)} names missing image {filename}")
        return problems

    if report.guarded(f"{relative(catalog)} Contents.json files are valid JSON", catalog_json):
        report.guarded(
            "the app icon and accent colour named in build settings exist in the asset catalog",
            catalog_names,
        )


def main() -> int:
    report = Report()
    try:
        run(report)
    except Exception as error:  # noqa: BLE001 - a crash is a failed verification
        report.check("verifier ran to completion", f"{type(error).__name__}: {error}")
    total = report.passed + report.failed
    if report.failed:
        print(f"\n{report.failed} of {total} checks FAILED")
        return 1
    print(f"\nall {total} checks passed (structure only; not opened or built in Xcode)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
