/** Behavioural drivers by case identifier. Cases without one run through the generic conversation path. */
import type { BehaviourDriver } from "../kit.ts";
import { accountingDrivers } from "./accounting.ts";
import { featureDrivers } from "./features.ts";

export const drivers: Record<string, BehaviourDriver> = { ...accountingDrivers, ...featureDrivers };
