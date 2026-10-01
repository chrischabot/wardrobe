/**
 * The versioned `weather-for-outfits` backend skill (specification section 7): instructions for
 * interpreting forecast fields for clothing, plus the two typed tools that obtain current data.
 * The context assembler calls the same service automatically before evening planning, morning
 * validation, weather-affected swaps, packing and ad hoc advice; a model never has to remember to.
 */
import { WeatherCompareLocationsInput, WeatherComparison, WeatherForecastInput, WeatherSnapshot } from "@garderobe/contracts/ext/daily";

export const WEATHER_SKILL = {
  name: "weather-for-outfits",
  version: "1.0.0",
  description: "Interpret current, location-specific forecast evidence when proposing, validating, swapping or packing outfits.",
  instructions: [
    "The backend has already preloaded a forecast snapshot for the day; inspect its coverage and freshness before reasoning. Call weather.forecast only when the requested interval or place is missing or stale, and weather.compare_locations for explicit travel between places. Search snippets are never the forecast authority.",
    "Use the owner's saved home city unless a specific destination is established. An ambiguous calendar venue does not establish travel. Continuous phone location is never required.",
    "Temperatures are Celsius. A null field means the provider did not supply it: never read it as zero, dry, warm or calm.",
    "Base layers, trousers and socks follow the peak across the planned daytime wearing interval; an explicitly evening-only outfit uses its evening interval. Morning outerwear follows departure conditions. Apparent temperature adds context and never replaces a rule's temperature basis.",
    "At 14 to 16 °C (inclusive) during the outdoor interval when a jacket is worn, the shirt under it must be a lightweight oxford: a hard combination rule, interpreted on the jacket-wearing interval and editable by the owner.",
    "A forecast cannot override socks, a healing restriction, laundry, stock availability or a standing owner direction. If the available garments cannot satisfy every condition, state the concrete compromise and return fewer valid choices.",
    "Rain probability and rain amount are different things. Consider wind, exposure and duration; do not treat every chance of rain as an all-day downpour. Never infer waterproofing from an image, and do not present water resistance as suitability for prolonged rain.",
    "On provider failure a prior snapshot may be used only while it still covers the place and interval and its age is acceptable; disclose the limitation. If weather remains unknown, do not describe the day as dry or warm.",
    "Keep the visible board line brief; hourly detail, source and update time are available on demand. The recommendation validator checks garment constraints independently of any prose.",
  ].join("\n"),
  attribution: { "open-meteo": "Weather data by Open-Meteo.com", weatherkit: "Apple Weather (https://weatherkit.apple.com/legal-attribution.html)" },
} as const;

/** Typed tool definitions; the handlers are `weatherForecast` and `weatherCompareLocations`. */
export const WEATHER_TOOLS = {
  "weather.forecast": { description: "Hourly forecast snapshot and outfit-relevant windows for one local day at the owner's home city or an explicit place.", input: WeatherForecastInput, output: WeatherSnapshot },
  "weather.compare_locations": { description: "Forecast snapshots for two to four places on one local day, with factual differences, for explicit travel.", input: WeatherCompareLocationsInput, output: WeatherComparison },
} as const;
