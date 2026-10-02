/** The real API client for the site snapshot, with token logos served from captured data: URIs. */
import data from "virtual:skein-site";

export * from "../src/api";

/** An address without a captured logo gets an empty image, so the monogram shows. */
export const logoUrl = (address: string) => data.logos[address.toLowerCase()] ?? "data:,";
