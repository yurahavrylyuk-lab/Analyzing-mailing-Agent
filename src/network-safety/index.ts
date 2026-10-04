export { createNodeDnsResolver } from "./dns-resolver";
export type { DnsAddressRecord, DnsResolver } from "./dns-resolver";
export {
  NETWORK_TARGET_ERROR_CODES,
  NetworkTargetError,
} from "./errors";
export type { NetworkTargetErrorCode } from "./errors";
export { normalizeNetworkUrl } from "./network-url";
export {
  resolveSafeRedirect,
  resolveSafeTarget,
} from "./resolve-target";
export type { SafeNetworkTarget } from "./resolve-target";
