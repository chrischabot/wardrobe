---
name: weather-for-outfits
description: Interpret current, location-specific forecast evidence when proposing, validating, swapping or packing outfits. Intended for the replacement backend skill registry; requires its typed weather tools.
---

# Weather for outfits

This is a product skill supplied with the replacement design. Its tool contracts are implementation requirements, not tools installed in the current Codex session.

Load this skill for scheduled outfit preparation and validation, weather-sensitive swaps, packing, and conversational outfit advice. The backend automatically preloads a forecast snapshot; inspect its coverage and freshness before reasoning. Use `weather.forecast` if the requested interval or place is missing or stale. Use `weather.compare_locations` for explicit travel between places. Do not use weather search snippets as the forecast authority.

## Inputs and evidence

Require a location label, timezone, requested local day and relevant outdoor intervals. Use the owner's saved home city unless a specific destination is established. An ambiguous calendar venue does not establish travel. Do not require continuous phone location access.

Read hourly temperature, apparent temperature, rain probability, rain amount, precipitation type, wind and gusts, humidity and available alerts. Preserve provider, fetch time, forecast issue time when available, interval coverage and missing fields. Keep temperatures in Celsius and normalize other units explicitly. Never interpret missing values as zero.

## Clothing decisions

Use peak daytime temperature for base layers and departure conditions for morning outerwear, according to the active profile. Apparent temperature adds context; it does not silently replace an explicit temperature threshold. Inspect return-time rain and outdoor exposure, not only the daily icon.

A forecast cannot override socks, medical or healing restrictions, laundry, stock availability, or a standing owner direction. At 14–16 °C during the outdoor interval when a jacket is worn, apply the active light-oxford-only jacket rule as a hard combination constraint. This interval interpretation is recorded in the design and can be amended by the owner. Full-day base garments use the peak across the planned daytime wearing interval; an explicitly evening-only outfit uses its requested evening interval. Do not invent a waterproof rating from an image. If available garments cannot satisfy every condition, explain the concrete compromise and return fewer valid choices if necessary.

Treat rain probability and amount as distinct. Consider wind, exposure and duration rather than treating every chance of rain as an all-day downpour. Record owner-confirmed comfort feedback through the ordinary dated preference command.

## Output

Return a structured weather assessment linked to the snapshot ID and revision, with the relevant intervals, clothing implications, evidence and uncertainty. Keep the visible board line concise; offer hourly details, source and update time on demand. The recommendation validator checks the underlying garment constraints independently of this prose.

On provider failure, use a prior snapshot only if it still covers the requested place and interval and its age is acceptable. Disclose a material limitation. If weather remains unknown, do not describe the day as dry or warm. The latest board can remain available with an appropriate validity status.

## Acceptance examples

Test cold departure/warm afternoon, late rain, strong wind, timezone travel, absent location permission, stale forecasts, missing fields and provider outage. Run these tests for both scheduled service and interactive advice. The backend must fetch before model reasoning even when the model makes no weather tool call.
