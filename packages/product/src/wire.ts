/** Wire types shared by the server and the web client (no Node imports). */

/** Wire form of a server type: every bigint is a decimal string. */
export type Wire<T> = T extends bigint
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends readonly (infer U)[]
      ? readonly Wire<U>[]
      : T extends object
        ? { [K in keyof T]: Wire<T[K]> }
        : T;

export interface AssetListItem {
  key: string;
  symbol: string;
  name: string;
  type: string;
  address: string;
  decimals: number;
}
