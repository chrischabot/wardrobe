#!/usr/bin/env python3
"""Generate ios/Garderobe.xcodeproj deterministically.

There is no Xcode on the machines that edit this repository, so the project
file is produced by this script instead of being edited by hand or by Xcode.

    python3 ios/Tools/generate-xcodeproj.py           write the project
    python3 ios/Tools/generate-xcodeproj.py --check   write nothing; exit 1 if
                                                      the committed files differ

Paths are resolved relative to this script, so the working directory does not
matter. Only the Python standard library is used.

What is written (all under ios/Garderobe.xcodeproj/):
    project.pbxproj
    project.xcworkspace/contents.xcworkspacedata
    xcshareddata/xcschemes/Garderobe.xcscheme

The project uses the Xcode 16 format (objectVersion 77) with file-system
synchronized folders: App/Garderobe, App/GarderobeShare and App/GarderobeUITests
are PBXFileSystemSynchronizedRootGroup objects, so a Swift file added to one of
those folders belongs to its target without any change here. Re-run this script
only when the project structure changes (targets, settings, exceptions).

Object identifiers are the first 24 hexadecimal digits of the SHA-256 of a
stable name, so the output is byte-identical on every run.

The output is checked structurally by ios/Tools/check-xcodeproj.py. This script
was written on a machine without Xcode, so the layout follows what Xcode 16 and
later write but was not produced by Xcode. If Xcode rewrites the file on first
open, port the difference back into this script.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

IOS_DIR = Path(__file__).resolve().parent.parent
PROJECT_NAME = "Garderobe"
PROJECT_DIR_NAME = f"{PROJECT_NAME}.xcodeproj"
PROJECT_DIR = IOS_DIR / PROJECT_DIR_NAME

# Project format. 77 is the object version Xcode 16 introduced together with
# file-system synchronized groups.
OBJECT_VERSION = 77
# Xcode release recorded as the last one that checked the project settings
# (LastUpgradeCheck, LastSwiftUpdateCheck, the scheme's LastUpgradeVersion) and
# as the creating tools version. Xcode 26 is the first release with an iOS 26
# SDK, which is the oldest SDK this app can be built with.
XCODE_UPGRADE_CHECK = "2600"
XCODE_TOOLS_VERSION = "26.0"

PACKAGE_NAME = "GarderobeKit"  # directory next to the .xcodeproj
PACKAGE_PRODUCT = "GarderobeKit"  # library product of that package
PACKAGE_TEST_TARGET = "GarderobeKitTests"

CONFIG_DIR = "Config"
CONFIG_FILES = ("Base.xcconfig", "Debug.xcconfig", "Release.xcconfig")
CONFIGURATIONS = ("Debug", "Release")

APP_DIR = "App"  # parent folder of the three synchronized source folders


# ---------------------------------------------------------------------------
# Target descriptions
# ---------------------------------------------------------------------------


class Target:
    def __init__(
        self,
        name: str,
        product: str,
        product_type: str,
        product_file_type: str,
        membership_exceptions: tuple[str, ...],
        links_package: bool,
        build_settings: dict,
    ) -> None:
        self.name = name
        self.product = product
        self.product_type = product_type
        self.product_file_type = product_file_type
        # Files inside the synchronized folder that must not be members of the
        # target (they would otherwise be copied into the bundle as resources).
        self.membership_exceptions = tuple(sorted(membership_exceptions))
        self.links_package = links_package
        self.build_settings = build_settings

    @property
    def folder(self) -> str:
        """Folder name under App/; identical to the target name."""
        return self.name


APP = Target(
    name="Garderobe",
    product="Garderobe.app",
    product_type="com.apple.product-type.application",
    product_file_type="wrapper.application",
    membership_exceptions=("Info.plist", "Garderobe.entitlements"),
    links_package=True,
    build_settings={
        "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME": "AccentColor",
        "CODE_SIGN_ENTITLEMENTS": f"{APP_DIR}/Garderobe/Garderobe.entitlements",
        "GENERATE_INFOPLIST_FILE": "NO",
        "INFOPLIST_FILE": f"{APP_DIR}/Garderobe/Info.plist",
        "LD_RUNPATH_SEARCH_PATHS": [
            "$(inherited)",
            "@executable_path/Frameworks",
        ],
        "PRODUCT_BUNDLE_IDENTIFIER": "$(GARDEROBE_BUNDLE_ID_PREFIX)",
        "PRODUCT_NAME": "$(TARGET_NAME)",
    },
)

SHARE = Target(
    name="GarderobeShare",
    product="GarderobeShare.appex",
    product_type="com.apple.product-type.app-extension",
    product_file_type="wrapper.app-extension",
    membership_exceptions=("Info.plist", "GarderobeShare.entitlements"),
    links_package=True,
    build_settings={
        "CODE_SIGN_ENTITLEMENTS": f"{APP_DIR}/GarderobeShare/GarderobeShare.entitlements",
        "GENERATE_INFOPLIST_FILE": "NO",
        "INFOPLIST_FILE": f"{APP_DIR}/GarderobeShare/Info.plist",
        "LD_RUNPATH_SEARCH_PATHS": [
            "$(inherited)",
            "@executable_path/Frameworks",
            "@executable_path/../../Frameworks",
        ],
        "PRODUCT_BUNDLE_IDENTIFIER": "$(GARDEROBE_BUNDLE_ID_PREFIX).share",
        "PRODUCT_NAME": "$(TARGET_NAME)",
        "SKIP_INSTALL": "YES",
    },
)

UI_TESTS = Target(
    name="GarderobeUITests",
    product="GarderobeUITests.xctest",
    product_type="com.apple.product-type.bundle.ui-testing",
    product_file_type="wrapper.cfbundle",
    membership_exceptions=(),
    links_package=False,
    build_settings={
        "GENERATE_INFOPLIST_FILE": "YES",
        "PRODUCT_BUNDLE_IDENTIFIER": "$(GARDEROBE_BUNDLE_ID_PREFIX).uitests",
        "PRODUCT_NAME": "$(TARGET_NAME)",
        "TEST_TARGET_NAME": APP.name,
    },
)

TARGETS = (APP, SHARE, UI_TESTS)


# ---------------------------------------------------------------------------
# Object graph
# ---------------------------------------------------------------------------


def object_id(key: str) -> str:
    """24 uppercase hexadecimal characters derived from a stable name."""
    digest = hashlib.sha256(f"{PROJECT_NAME}.xcodeproj:{key}".encode("utf-8"))
    return digest.hexdigest()[:24].upper()


class Ref:
    """Reference to another object, by its stable name.

    Xcode annotates most references with a comment naming the target object;
    a few (dictionary keys, remoteGlobalIDString, TestTargetID) are written as
    the bare identifier, which is what annotate=False produces.
    """

    __slots__ = ("key", "annotate")

    def __init__(self, key: str, annotate: bool = True) -> None:
        self.key = key
        self.annotate = annotate

    def __hash__(self) -> int:
        return hash((self.key, self.annotate))

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Ref)
            and other.key == self.key
            and other.annotate == self.annotate
        )


class PBXObject:
    __slots__ = ("key", "isa", "comment", "fields")

    def __init__(self, key: str, isa: str, comment: str, fields: dict) -> None:
        self.key = key
        self.isa = isa
        self.comment = comment
        self.fields = fields


class Graph:
    def __init__(self) -> None:
        self.objects: dict[str, PBXObject] = {}
        self._ids: dict[str, str] = {}

    def add(self, key: str, isa: str, comment: str, **fields: object) -> Ref:
        if key in self.objects:
            raise ValueError(f"duplicate object name: {key}")
        identifier = object_id(key)
        if identifier in self._ids:
            raise ValueError(
                f"identifier collision between {key!r} and {self._ids[identifier]!r}"
            )
        self._ids[identifier] = key
        self.objects[key] = PBXObject(key, isa, comment, dict(fields))
        return Ref(key)


# ---------------------------------------------------------------------------
# OpenStep (ASCII) property list writer, in the layout Xcode uses
# ---------------------------------------------------------------------------

# Xcode writes a string without quotes only when it is non-empty and made of
# these characters; everything else is quoted. Two cases are quoted even though
# their characters are plain: a double slash (it would read as a comment) and a
# triple underscore (Xcode's own writer quotes it).
_PLAIN_STRING = re.compile(r"\A[A-Za-z0-9_$./]+\Z")

# These object classes are written on a single line.
_SINGLE_LINE_CLASSES = frozenset({"PBXBuildFile", "PBXFileReference"})


def quote(text: str) -> str:
    if _PLAIN_STRING.match(text) and "//" not in text and "___" not in text:
        return text
    escaped = (
        text.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


class Writer:
    def __init__(self, graph: Graph) -> None:
        self.graph = graph

    def reference(self, ref: Ref) -> str:
        target = self.graph.objects.get(ref.key)
        if target is None:
            raise KeyError(f"reference to an object that was never added: {ref.key}")
        identifier = object_id(ref.key)
        if ref.annotate and target.comment:
            return f"{identifier} /* {target.comment} */"
        return identifier

    def scalar(self, value: object) -> str:
        if isinstance(value, Ref):
            return self.reference(value)
        if isinstance(value, bool):
            raise TypeError("booleans are written as the strings YES/NO or 0/1")
        if isinstance(value, int):
            return str(value)
        if isinstance(value, str):
            return quote(value)
        raise TypeError(f"unsupported value: {value!r}")

    def ordered(self, mapping: dict) -> list[tuple[str, object]]:
        """Keys rendered and sorted the way Xcode does: isa first, then by name."""
        rendered = [(self.scalar(key), value) for key, value in mapping.items()]
        rendered.sort(key=lambda item: (item[0] != "isa", item[0]))
        return rendered

    def value(self, value: object, depth: int, single_line: bool) -> str:
        tabs = "\t" * depth
        if isinstance(value, dict):
            items = self.ordered(value)
            if single_line:
                body = "".join(
                    f"{key} = {self.value(item, depth, True)}; " for key, item in items
                )
                return "{" + body + "}"
            body = "".join(
                f"{tabs}\t{key} = {self.value(item, depth + 1, False)};\n"
                for key, item in items
            )
            return "{\n" + body + tabs + "}"
        if isinstance(value, (list, tuple)):
            if single_line:
                body = "".join(f"{self.value(item, depth, True)}, " for item in value)
                return "(" + body + ")"
            body = "".join(
                f"{tabs}\t{self.value(item, depth + 1, False)},\n" for item in value
            )
            return "(\n" + body + tabs + ")"
        return self.scalar(value)

    def object_entry(self, obj: PBXObject) -> str:
        identifier = object_id(obj.key)
        label = f"{identifier} /* {obj.comment} */" if obj.comment else identifier
        fields = {"isa": obj.isa}
        fields.update(
            (name, value) for name, value in obj.fields.items() if value is not None
        )
        body = self.value(fields, 2, obj.isa in _SINGLE_LINE_CLASSES)
        return f"\t\t{label} = {body};\n"

    def document(self, root: Ref) -> str:
        sections: dict[str, list[PBXObject]] = {}
        for obj in self.graph.objects.values():
            sections.setdefault(obj.isa, []).append(obj)

        out = [
            "// !$*UTF8*$!\n",
            "{\n",
            "\tarchiveVersion = 1;\n",
            "\tclasses = {\n",
            "\t};\n",
            f"\tobjectVersion = {OBJECT_VERSION};\n",
            "\tobjects = {\n",
        ]
        # Sections in class-name order, objects in identifier order, each
        # section preceded by a blank line: the layout Xcode writes.
        for isa in sorted(sections):
            out.append("\n")
            out.append(f"/* Begin {isa} section */\n")
            for obj in sorted(sections[isa], key=lambda item: object_id(item.key)):
                out.append(self.object_entry(obj))
            out.append(f"/* End {isa} section */\n")
        out.append("\t};\n")
        out.append(f"\trootObject = {self.reference(root)};\n")
        out.append("}\n")
        return "".join(out)


# ---------------------------------------------------------------------------
# The project
# ---------------------------------------------------------------------------


def build_graph() -> tuple[Graph, Ref]:
    g = Graph()
    project = Ref("project")

    # --- xcconfig file references -----------------------------------------
    config_refs = {
        name: g.add(
            f"file.config.{name}",
            "PBXFileReference",
            name,
            lastKnownFileType="text.xcconfig",
            path=name,
            sourceTree="<group>",
        )
        for name in CONFIG_FILES
    }

    def configuration_list(owner_key: str, owner_isa: str, owner_name: str,
                           settings: dict) -> Ref:
        configurations = [
            g.add(
                f"config.{owner_key}.{name}",
                "XCBuildConfiguration",
                name,
                baseConfigurationReference=config_refs[f"{name}.xcconfig"],
                buildSettings=dict(settings),
                name=name,
            )
            for name in CONFIGURATIONS
        ]
        return g.add(
            f"configlist.{owner_key}",
            "XCConfigurationList",
            f'Build configuration list for {owner_isa} "{owner_name}"',
            buildConfigurations=configurations,
            defaultConfigurationIsVisible=0,
            defaultConfigurationName="Release",
        )

    # --- local Swift package ----------------------------------------------
    package = g.add(
        f"package.{PACKAGE_NAME}",
        "XCLocalSwiftPackageReference",
        f'XCLocalSwiftPackageReference "{PACKAGE_NAME}"',
        relativePath=PACKAGE_NAME,
    )

    # --- per-target objects ------------------------------------------------
    target_refs: dict[str, Ref] = {}
    product_refs: dict[str, Ref] = {}
    folder_refs: dict[str, Ref] = {}
    extra_phases: dict[str, list[Ref]] = {t.name: [] for t in TARGETS}
    dependencies: dict[str, list[Ref]] = {t.name: [] for t in TARGETS}

    for t in TARGETS:
        target_refs[t.name] = Ref(f"target.{t.name}")
        product_refs[t.name] = g.add(
            f"product.{t.name}",
            "PBXFileReference",
            t.product,
            explicitFileType=t.product_file_type,
            includeInIndex=0,
            path=t.product,
            sourceTree="BUILT_PRODUCTS_DIR",
        )

        exception_sets = []
        if t.membership_exceptions:
            exception_sets.append(
                g.add(
                    f"syncexceptions.{t.name}.{t.name}",
                    "PBXFileSystemSynchronizedBuildFileExceptionSet",
                    f'Exceptions for "{t.folder}" folder in "{t.name}" target',
                    membershipExceptions=list(t.membership_exceptions),
                    target=target_refs[t.name],
                )
            )
        folder_refs[t.name] = g.add(
            f"syncgroup.{t.name}",
            "PBXFileSystemSynchronizedRootGroup",
            t.folder,
            exceptions=exception_sets or None,
            path=t.folder,
            sourceTree="<group>",
        )

    def depend(dependent: Target, dependency: Target) -> None:
        key = f"{dependent.name}.on.{dependency.name}"
        proxy = g.add(
            f"proxy.{key}",
            "PBXContainerItemProxy",
            "PBXContainerItemProxy",
            containerPortal=project,
            proxyType=1,
            remoteGlobalIDString=Ref(f"target.{dependency.name}", annotate=False),
            remoteInfo=dependency.name,
        )
        dependencies[dependent.name].append(
            g.add(
                f"dependency.{key}",
                "PBXTargetDependency",
                "PBXTargetDependency",
                target=target_refs[dependency.name],
                targetProxy=proxy,
            )
        )

    # The app embeds the share extension and therefore builds it first.
    depend(APP, SHARE)
    embed_phase_name = "Embed Foundation Extensions"
    embedded = g.add(
        f"buildfile.{APP.name}.embed.{SHARE.name}",
        "PBXBuildFile",
        f"{SHARE.product} in {embed_phase_name}",
        fileRef=product_refs[SHARE.name],
        settings={"ATTRIBUTES": ["RemoveHeadersOnCopy"]},
    )
    extra_phases[APP.name].append(
        g.add(
            f"phase.{APP.name}.embed",
            "PBXCopyFilesBuildPhase",
            embed_phase_name,
            buildActionMask=2147483647,
            dstPath="",
            dstSubfolderSpec=13,  # PlugIns, the folder for app extensions
            files=[embedded],
            name=embed_phase_name,
            runOnlyForDeploymentPostprocessing=0,
        )
    )
    # The UI tests drive the app.
    depend(UI_TESTS, APP)

    for t in TARGETS:
        package_products = []
        framework_files = []
        if t.links_package:
            product_dependency = g.add(
                f"packageproduct.{t.name}.{PACKAGE_PRODUCT}",
                "XCSwiftPackageProductDependency",
                PACKAGE_PRODUCT,
                productName=PACKAGE_PRODUCT,
            )
            package_products.append(product_dependency)
            framework_files.append(
                g.add(
                    f"buildfile.{t.name}.frameworks.{PACKAGE_PRODUCT}",
                    "PBXBuildFile",
                    f"{PACKAGE_PRODUCT} in Frameworks",
                    productRef=product_dependency,
                )
            )

        def phase(kind: str, isa: str, files: list) -> Ref:
            return g.add(
                f"phase.{t.name}.{kind.lower()}",
                isa,
                kind,
                buildActionMask=2147483647,
                files=files,
                runOnlyForDeploymentPostprocessing=0,
            )

        phases = [
            phase("Sources", "PBXSourcesBuildPhase", []),
            phase("Frameworks", "PBXFrameworksBuildPhase", framework_files),
            phase("Resources", "PBXResourcesBuildPhase", []),
        ] + extra_phases[t.name]

        g.add(
            f"target.{t.name}",
            "PBXNativeTarget",
            t.name,
            buildConfigurationList=configuration_list(
                f"target.{t.name}", "PBXNativeTarget", t.name, t.build_settings
            ),
            buildPhases=phases,
            buildRules=[],
            dependencies=dependencies[t.name],
            fileSystemSynchronizedGroups=[folder_refs[t.name]],
            name=t.name,
            packageProductDependencies=package_products,
            productName=t.name,
            productReference=product_refs[t.name],
            productType=t.product_type,
        )

    # --- groups -------------------------------------------------------------
    app_group = g.add(
        "group.app",
        "PBXGroup",
        APP_DIR,
        children=[folder_refs[t.name] for t in TARGETS],
        path=APP_DIR,
        sourceTree="<group>",
    )
    config_group = g.add(
        "group.config",
        "PBXGroup",
        CONFIG_DIR,
        children=[config_refs[name] for name in CONFIG_FILES],
        path=CONFIG_DIR,
        sourceTree="<group>",
    )
    products_group = g.add(
        "group.products",
        "PBXGroup",
        "Products",
        children=[product_refs[t.name] for t in TARGETS],
        name="Products",
        sourceTree="<group>",
    )
    main_group = g.add(
        "group.main",
        "PBXGroup",
        "",
        children=[app_group, config_group, products_group],
        sourceTree="<group>",
    )

    # --- project ------------------------------------------------------------
    target_attributes = {}
    for t in TARGETS:
        attributes: dict = {"CreatedOnToolsVersion": XCODE_TOOLS_VERSION}
        if t is UI_TESTS:
            attributes["TestTargetID"] = Ref(f"target.{APP.name}", annotate=False)
        target_attributes[Ref(f"target.{t.name}", annotate=False)] = attributes

    g.add(
        "project",
        "PBXProject",
        "Project object",
        attributes={
            "BuildIndependentTargetsInParallel": 1,
            "LastSwiftUpdateCheck": XCODE_UPGRADE_CHECK,
            "LastUpgradeCheck": XCODE_UPGRADE_CHECK,
            "TargetAttributes": target_attributes,
        },
        buildConfigurationList=configuration_list(
            "project", "PBXProject", PROJECT_NAME, {}
        ),
        developmentRegion="en",
        hasScannedForEncodings=0,
        knownRegions=["en", "Base"],
        mainGroup=main_group,
        minimizedProjectReferenceProxies=1,
        packageReferences=[package],
        preferredProjectObjectVersion=OBJECT_VERSION,
        productRefGroup=products_group,
        projectDirPath="",
        projectRoot="",
        targets=[target_refs[t.name] for t in TARGETS],
    )
    return g, project


def render_pbxproj() -> str:
    graph, project = build_graph()
    return Writer(graph).document(project)


# ---------------------------------------------------------------------------
# Scheme and workspace data
# ---------------------------------------------------------------------------


def _buildable_reference(indent: str, blueprint: str, buildable_name: str,
                         blueprint_name: str, container: str) -> str:
    return (
        f"{indent}<BuildableReference\n"
        f'{indent}   BuildableIdentifier = "primary"\n'
        f'{indent}   BlueprintIdentifier = "{blueprint}"\n'
        f'{indent}   BuildableName = "{buildable_name}"\n'
        f'{indent}   BlueprintName = "{blueprint_name}"\n'
        f'{indent}   ReferencedContainer = "container:{container}">\n'
        f"{indent}</BuildableReference>\n"
    )


def _target_reference(indent: str, target: Target) -> str:
    return _buildable_reference(
        indent,
        object_id(f"target.{target.name}"),
        target.product,
        target.name,
        PROJECT_DIR_NAME,
    )


def render_scheme() -> str:
    app_runnable = _target_reference("         ", APP)
    # A test target of a local package is addressed by name, in the package
    # directory as its container.
    package_tests = _buildable_reference(
        "            ",
        PACKAGE_TEST_TARGET,
        PACKAGE_TEST_TARGET,
        PACKAGE_TEST_TARGET,
        PACKAGE_NAME,
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Scheme\n"
        f'   LastUpgradeVersion = "{XCODE_UPGRADE_CHECK}"\n'
        '   version = "1.7">\n'
        "   <BuildAction\n"
        '      parallelizeBuildables = "YES"\n'
        '      buildImplicitDependencies = "YES"\n'
        '      buildArchitectures = "Automatic">\n'
        "      <BuildActionEntries>\n"
        "         <BuildActionEntry\n"
        '            buildForTesting = "YES"\n'
        '            buildForRunning = "YES"\n'
        '            buildForProfiling = "YES"\n'
        '            buildForArchiving = "YES"\n'
        '            buildForAnalyzing = "YES">\n'
        + _target_reference("            ", APP)
        + "         </BuildActionEntry>\n"
        "      </BuildActionEntries>\n"
        "   </BuildAction>\n"
        "   <TestAction\n"
        '      buildConfiguration = "Debug"\n'
        '      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"\n'
        '      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"\n'
        '      shouldUseLaunchSchemeArgsEnv = "YES"\n'
        '      shouldAutocreateTestPlan = "YES">\n'
        "      <Testables>\n"
        "         <TestableReference\n"
        '            skipped = "NO">\n'
        + package_tests
        + "         </TestableReference>\n"
        "         <TestableReference\n"
        '            skipped = "NO">\n'
        + _target_reference("            ", UI_TESTS)
        + "         </TestableReference>\n"
        "      </Testables>\n"
        "   </TestAction>\n"
        "   <LaunchAction\n"
        '      buildConfiguration = "Debug"\n'
        '      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"\n'
        '      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"\n'
        '      launchStyle = "0"\n'
        '      useCustomWorkingDirectory = "NO"\n'
        '      ignoresPersistentStateOnLaunch = "NO"\n'
        '      debugDocumentVersioning = "YES"\n'
        '      debugServiceExtension = "internal"\n'
        '      allowLocationSimulation = "YES">\n'
        "      <BuildableProductRunnable\n"
        '         runnableDebuggingMode = "0">\n'
        + app_runnable
        + "      </BuildableProductRunnable>\n"
        "   </LaunchAction>\n"
        "   <ProfileAction\n"
        '      buildConfiguration = "Release"\n'
        '      shouldUseLaunchSchemeArgsEnv = "YES"\n'
        '      savedToolIdentifier = ""\n'
        '      useCustomWorkingDirectory = "NO"\n'
        '      debugDocumentVersioning = "YES">\n'
        "      <BuildableProductRunnable\n"
        '         runnableDebuggingMode = "0">\n'
        + app_runnable
        + "      </BuildableProductRunnable>\n"
        "   </ProfileAction>\n"
        "   <AnalyzeAction\n"
        '      buildConfiguration = "Debug">\n'
        "   </AnalyzeAction>\n"
        "   <ArchiveAction\n"
        '      buildConfiguration = "Release"\n'
        '      revealArchiveInOrganizer = "YES">\n'
        "   </ArchiveAction>\n"
        "</Scheme>\n"
    )


def render_workspace_data() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Workspace\n"
        '   version = "1.0">\n'
        "   <FileRef\n"
        '      location = "self:">\n'
        "   </FileRef>\n"
        "</Workspace>\n"
    )


def render_all() -> dict[str, bytes]:
    """Every generated file, keyed by its path inside the .xcodeproj."""
    files = {
        "project.pbxproj": render_pbxproj(),
        "project.xcworkspace/contents.xcworkspacedata": render_workspace_data(),
        f"xcshareddata/xcschemes/{PROJECT_NAME}.xcscheme": render_scheme(),
    }
    return {path: text.encode("utf-8") for path, text in files.items()}


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=f"Generate {PROJECT_DIR_NAME} next to the App/ and Config/ folders."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing; exit 1 if the files on disk differ from fresh output",
    )
    args = parser.parse_args(argv)

    outputs = render_all()

    if args.check:
        stale = []
        for relative, expected in sorted(outputs.items()):
            path = PROJECT_DIR / relative
            if not path.is_file():
                stale.append(f"missing: {PROJECT_DIR_NAME}/{relative}")
            elif path.read_bytes() != expected:
                stale.append(f"differs: {PROJECT_DIR_NAME}/{relative}")
        if stale:
            for line in stale:
                print(line, file=sys.stderr)
            print(
                "The Xcode project is out of date. Run "
                "python3 ios/Tools/generate-xcodeproj.py and commit the result.",
                file=sys.stderr,
            )
            return 1
        print(f"{PROJECT_DIR_NAME} is up to date ({len(outputs)} files checked).")
        return 0

    for relative, content in sorted(outputs.items()):
        path = PROJECT_DIR / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        print(f"wrote {PROJECT_DIR_NAME}/{relative} ({len(content)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
