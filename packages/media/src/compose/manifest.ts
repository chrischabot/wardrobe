/**
 * Deterministic outfit composition: a manifest that arranges approved garment assets on a white canvas.
 * No image model is involved. The same slots and renditions always give the same manifest and the same
 * content hash; swapping one garment changes one layer and therefore the hash of only that composite.
 */
import { canonicalJson, sha256Hex } from "@garderobe/domain";
import type { Role } from "@garderobe/contracts";
import type { CompositionLayer, CompositionManifest, CompositionTemplateName, GarmentImageRef } from "@garderobe/contracts/ext/media";

export const TEMPLATE_VERSION = "layout-1";
export const CANVAS = { width: 900, height: 1200, background: "#FFFFFF" } as const;

export interface ComposeSlot {
  role: Role;
  garmentId: string | null;
  shoppingCandidateId: string | null;
  /** Perceptible name from the garment record (or the candidate's label). */
  name: string;
  category: string;
  /** Garment attributes relevant to layout only. */
  outerLength?: "long" | "short" | null;
  image: GarmentImageRef | null;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

const MAIN: Record<"centre" | "right", { top: Box; bottom: Box; footwear: Box; onePiece: Box }> = {
  centre: {
    top: { x: 0.22, y: 0.04, width: 0.56, height: 0.36, z: 30 },
    bottom: { x: 0.26, y: 0.4, width: 0.48, height: 0.4, z: 20 },
    footwear: { x: 0.3, y: 0.81, width: 0.4, height: 0.16, z: 40 },
    onePiece: { x: 0.22, y: 0.04, width: 0.56, height: 0.76, z: 25 },
  },
  // With an outer layer the main column moves right and the outer layer sits beside it, partly layered.
  right: {
    top: { x: 0.4, y: 0.05, width: 0.5, height: 0.34, z: 30 },
    bottom: { x: 0.43, y: 0.39, width: 0.44, height: 0.4, z: 20 },
    footwear: { x: 0.45, y: 0.8, width: 0.38, height: 0.16, z: 40 },
    onePiece: { x: 0.4, y: 0.05, width: 0.5, height: 0.74, z: 25 },
  },
};

const OUTER: Record<"long" | "short", Box> = {
  long: { x: 0.02, y: 0.05, width: 0.44, height: 0.8, z: 10 },
  short: { x: 0.02, y: 0.05, width: 0.44, height: 0.48, z: 10 },
};

/** Category-based relative size inside a slot box (no trustworthy garment dimensions are assumed). */
const CATEGORY_SCALE: Record<string, number> = { shirt: 1, tee: 0.92, knitwear: 1, trousers: 1, outerwear: 1, footwear: 1, socks: 0.85, belt: 0.9, tie: 0.9, scarf: 0.95, pocket_square: 0.7, accessory: 0.85, one_piece: 1, other: 0.9 };

const ROLE_ORDER: Role[] = ["outer", "one_piece", "top", "mid_layer", "bottom", "footwear", "socks", "belt", "neckwear", "accessory"];
const ROLE_LABEL: Record<Role, string> = { top: "Top", mid_layer: "Layer", bottom: "Bottom", outer: "Outer layer", footwear: "Footwear", socks: "Socks", belt: "Belt", neckwear: "Neckwear", accessory: "Accessory", one_piece: "One-piece" };

const LONG_OUTER = /\b(coat|overcoat|trench|parka|mac|raincoat|duffle|ulster)\b/i;

export function isLongOuter(slot: Pick<ComposeSlot, "name" | "outerLength">): boolean {
  if (slot.outerLength === "long") return true;
  if (slot.outerLength === "short") return false;
  return LONG_OUTER.test(slot.name);
}

export function chooseTemplate(slots: ComposeSlot[]): CompositionTemplateName {
  const has = (role: Role) => slots.some((s) => s.role === role);
  const outer = slots.find((s) => s.role === "outer");
  if (has("one_piece")) return outer ? "one_piece_with_outer" : "one_piece";
  if (outer) return isLongOuter(outer) ? "separates_with_long_coat" : "separates_with_jacket";
  if (has("mid_layer") || slots.some((s) => s.role === "top" && s.category === "knitwear")) return "separates_with_knitwear";
  return "separates";
}

function imageLabel(slot: ComposeSlot): CompositionLayer["imageLabel"] {
  if (slot.shoppingCandidateId) return "shopping_candidate";
  const image = slot.image;
  if (!image || !image.renditionId) return "missing";
  if (image.isDemo) return "demo_placeholder";
  if (image.assetKind === "generic_illustration") return "illustration";
  if (image.displayLabel === "Edited" || image.assetKind === "edited_rendition") return "edited";
  return image.assetKind === "owner_photo" ? "owner_photo" : "exact";
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Build the manifest. Pure: the same input always yields the same manifest. */
export function buildManifest(input: ComposeSlot[]): CompositionManifest {
  const slots = [...input].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.garmentId ?? a.shoppingCandidateId ?? "").localeCompare(b.garmentId ?? b.shoppingCandidateId ?? ""));
  const template = chooseTemplate(slots);
  const withOuter = slots.some((s) => s.role === "outer");
  const main = MAIN[withOuter ? "right" : "centre"];
  const hasMid = slots.some((s) => s.role === "mid_layer");
  const counters = new Map<Role, number>();
  const layers: CompositionLayer[] = [];
  // Small pieces sit in consistent side positions; repeats of a role stack downwards.
  const sideX = withOuter ? 0.9 : 0.8;
  const sideW = withOuter ? 0.095 : 0.17;
  for (const slot of slots) {
    const n = counters.get(slot.role) ?? 0;
    counters.set(slot.role, n + 1);
    let box: Box;
    switch (slot.role) {
      case "top":
        // Under knitwear the shirt shows as a smaller piece tucked behind the main top position.
        box = hasMid ? { x: main.top.x - 0.1, y: main.top.y - 0.02, width: main.top.width * 0.62, height: main.top.height * 0.7, z: 28 } : main.top;
        break;
      case "mid_layer":
        box = main.top;
        break;
      case "bottom":
        box = main.bottom;
        break;
      case "one_piece":
        box = main.onePiece;
        break;
      case "footwear":
        box = main.footwear;
        break;
      case "outer":
        box = OUTER[isLongOuter(slot) ? "long" : "short"];
        break;
      case "socks":
        box = { x: withOuter ? 0.84 : 0.72, y: 0.85, width: 0.15, height: 0.12, z: 41 };
        break;
      case "belt":
        box = { x: sideX, y: 0.42, width: sideW, height: 0.07, z: 42 };
        break;
      case "neckwear":
        box = { x: sideX, y: 0.06, width: sideW, height: 0.2, z: 43 };
        break;
      default:
        box = { x: sideX, y: 0.52, width: sideW, height: 0.11, z: 44 };
    }
    if (n > 0) box = { ...box, x: Math.max(0, box.x - 0.012 * n), y: Math.min(0.98 - box.height, box.y + (box.height * 0.5 + 0.02) * n), z: box.z + n };
    const scale = CATEGORY_SCALE[slot.category] ?? 0.9;
    const w = box.width * scale;
    const h = box.height * scale;
    const label = imageLabel(slot);
    const hasImage = label !== "missing" && !!slot.image?.renditionId;
    layers.push({
      role: slot.role,
      garmentId: slot.garmentId,
      shoppingCandidateId: slot.shoppingCandidateId,
      name: slot.name,
      assetId: hasImage ? slot.image!.assetId : null,
      renditionId: hasImage ? slot.image!.renditionId : null,
      renditionVersion: hasImage ? slot.image!.renditionVersion : null,
      renditionSha256: hasImage ? slot.image!.renditionSha256 : null,
      imageLabel: hasImage ? label : slot.shoppingCandidateId ? "shopping_candidate" : "missing",
      x: round(box.x + (box.width - w) / 2),
      y: round(box.y + (box.height - h) / 2),
      width: round(w),
      height: round(h),
      scale,
      z: box.z,
    });
  }
  layers.sort((a, b) => a.z - b.z || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const caption = slots
    .map((s) => {
      const label = imageLabel(s);
      const note = label === "missing" ? " (no photo yet)" : label === "illustration" ? " (illustration)" : label === "demo_placeholder" ? " (demo placeholder)" : label === "shopping_candidate" ? " (shopping candidate, not owned)" : label === "edited" ? " (edited image)" : "";
      return `${ROLE_LABEL[s.role]}: ${s.name}${note}`;
    })
    .join(". ");
  return { templateVersion: TEMPLATE_VERSION, template, canvas: { ...CANVAS }, layers, caption: caption === "" ? "Empty outfit" : `${caption}.` };
}

export async function manifestHash(manifest: CompositionManifest): Promise<string> {
  return sha256Hex(canonicalJson(manifest));
}

/** Labels the presentation must show for a manifest. */
export function manifestLabels(manifest: CompositionManifest): string[] {
  const labels: string[] = [];
  const kinds = new Set(manifest.layers.map((l) => l.imageLabel));
  if (kinds.has("illustration")) labels.push("Illustration");
  if (kinds.has("demo_placeholder")) labels.push("Demo placeholder");
  if (kinds.has("shopping_candidate")) labels.push("Shopping candidate");
  if (kinds.has("edited")) labels.push("Edited");
  if (kinds.has("missing")) labels.push("No photo yet");
  return labels;
}

export const LAYER_TAG: Record<CompositionLayer["imageLabel"], string | null> = {
  exact: null,
  owner_photo: null,
  edited: "EDITED",
  illustration: "ILLUSTRATION",
  demo_placeholder: "DEMO PLACEHOLDER",
  shopping_candidate: "SHOPPING CANDIDATE",
  missing: "NO PHOTO YET",
};
