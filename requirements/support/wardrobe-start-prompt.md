Build Wardrobe/Garderobe from scratch as a fresh implementation; migrate only data and requirements, never the old application code, architecture or accumulated workflows. The following is the owner’s original Fabric kickoff, reproduced verbatim. Its historical attachment identifier is provenance; use the actual attached file in this new project.

Here's the spec for this project, please create this front to back, start to finish, and have a full functionality and user experience focused test suite as well as an extensive set of adversarial tests included. Once completed, test the full mcp server's functionality with demo data, random outfit selections and various simulated conditions around availability, weather, calendar entries, and circumstance.

Attached file "garderobe-replacement-design.md": fabric-attachment:9f174139-7da8-494a-98b1-d77b6af4f650

Use the complete revision 4 replacement-design attachment and the owner amendments, profile and inventory. Read every requirement, maintain a requirement-to-code/test checklist, and implement the working backend, native iOS client, API and MCP server rather than a skeleton. The profile and real inventory follow-up requests below are also binding for personalization, import and tests. Preserve supplied documents byte-for-byte, record their hashes, and report every imported inventory row; do not invent owned garments, wear history or lifted restrictions.

this is a profile for me that the app can use to customize the experience for me, pls set this when you get to the testing phase, and ensure this is implemented, and used, correctly

Attached file "chris-wardrobe-profile.md": fabric-attachment:905c1add-fb8b-4920-bf64-da767a9caaa9

And here's my wardrobe inventory db

Attached file "wardrobe_inventory_clean.csv": fabric-attachment:deb335fb-ecea-4519-ab27-21ca4eb0bd56

The implementation uses the specification’s TypeScript Cloudflare backend, D1 domain ledger and receipts, Think/Durable Object conversation authority, private R2 media, derived AI Search, AI Gateway inference, workflows/queues and native SwiftUI presentation. Verify current service contracts and isolate adapters; do not guess preview APIs. API/MCP and iOS use the same domain commands and durable effects. Preserve probabilistic availability, weekly laundry exceptions, authoritative owner observations, per-garment daily wear deduplication, automatic future-outfit repair and versioned Calendar replacement. Include Today, Wardrobe, Studio, Conversation/capture, trip packing, returns/exchanges, optional feedback, pause/resume, account recovery and portable export.

Create meaningful functional and UX tests, adversarial tests and the original requested full MCP simulation with seeded outfit choices, availability, weather, calendar and circumstance. Use actual application state and receipts for deterministic checks. The bundled 64-case evaluation corpus is calibration/input, not proof this new build passes; preserve candidate/judge isolation, development/holdout splits, and independent taste judging. Real owner stock replaces demo stock for personalization tests, while clearly labelled synthetic cases remain for boundary conditions. Never claim an unrun cloud or Xcode check passed. Continue independent implementation when a credential, entitlement or macOS toolchain is missing, with an exact remaining integration checklist.

Cloudflare management credentials are project secrets, never prompt/source material and never substitutes for the application’s own login/MCP OAuth. Use the authorized development and sandbox resources to complete the fresh build, tests and development deployment. Keep unrelated production resources untouched. Commit only owned changes on the current branch. Deliver runnable source, test commands/results, source archive, requirement coverage and remaining deployment/iOS acceptance steps.
