/**
 * SYNTHETIC TEST DATA - NOT THE OWNER'S WARDROBE.
 *
 * A small constructed wardrobe for boundary, accounting and isolation tests. Every garment created from
 * it is flagged `is_synthetic` and belongs to a user flagged `is_synthetic`. It deliberately reuses the
 * same garment IDs for every synthetic owner, so cross-owner isolation is tested with colliding IDs.
 * Nothing here asserts that the real owner owns or has worn anything.
 */
import type { CareChannel, Category, Role } from "@garderobe/contracts";

export const SYNTHETIC_LABEL = "synthetic test fixture";

export interface SyntheticGarment {
  id: string;
  name: string;
  category: Category;
  roles: Role[];
  careChannel: CareChannel;
  fabric?: string;
  colour?: string;
  quantity?: number;
  acquisition?: "owned" | "incoming";
  attributes?: Record<string, unknown>;
}

const shirt = (id: string, name: string, colour: string, fabricClass = "lightweight_oxford", fabric = "Cotton oxford"): SyntheticGarment => ({
  id, name, colour, fabric, category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass },
});
const trouser = (id: string, name: string, colour: string, quantity = 1): SyntheticGarment => ({
  id, name, colour, quantity, category: "trousers", roles: ["bottom"], careChannel: "service", fabric: "Cotton twill",
});
const sock = (id: string, name: string, colour: string, quantity: number): SyntheticGarment => ({
  id, name, colour, quantity, category: "socks", roles: ["socks"], careChannel: "handwash", fabric: "Merino wool", attributes: { fabricClass: "merino" },
});
const shoe = (id: string, name: string, colour: string, footwearKind: string, model: string): SyntheticGarment => ({
  id, name, colour, category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind, model },
});

export const SYNTHETIC_WARDROBE: SyntheticGarment[] = [
  shirt("shirt-moss", "moss lightweight oxford", "Moss"),
  shirt("shirt-gold", "gold lightweight oxford", "Gold"),
  shirt("shirt-red-stripe", "red stripe lightweight oxford", "Red stripe"),
  shirt("shirt-slate", "slate lightweight oxford", "Slate"),
  shirt("shirt-blue-stripe-a", "blue stripe lightweight oxford", "Blue stripe"),
  shirt("shirt-blue-stripe-b", "blue stripe cotton-linen oxford", "Blue stripe", "cotton_linen", "Cotton-linen oxford"),
  trouser("trouser-olive", "olive fatigues", "Olive"),
  trouser("trouser-beige", "beige chinos", "Beige"),
  trouser("trouser-navy", "navy chinos", "Navy", 2),
  { id: "jacket-blue-work", name: "blue work jacket", colour: "Blue", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true } },
  { id: "jacket-academic", name: "tweed academic blazer", colour: "Salt and pepper", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true } },
  shoe("shoe-navy", "navy 990v4 sneakers", "Navy", "sneaker", "990v4"),
  shoe("shoe-olive", "olive 990v4 sneakers", "Olive", "sneaker", "990v4"),
  shoe("shoe-990v6", "navy 990v6 sneakers", "Navy", "sneaker", "990v6"),
  shoe("shoe-welted", "brown welted derbies", "Brown", "welted", "Reims"),
  sock("sock-navy", "navy merino socks", "Navy", 2),
  sock("sock-grey", "grey merino socks", "Grey", 3),
  { id: "belt-brown", name: "brown woven belt", colour: "Brown", category: "belt", roles: ["belt"], careChannel: "none" },
  { id: "shirt-ordered", name: "ordered pink oxford", colour: "Pink", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "incoming", attributes: { fabricClass: "lightweight_oxford" } },
];
