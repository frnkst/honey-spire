import fs from "node:fs";
import path from "node:path";
import maxmind, {
  type AsnResponse,
  type CityResponse,
  type Response,
} from "maxmind";
import { getConfig } from "@/lib/config";

interface GeoResult {
  countryCode: string | null;
  countryName: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: number | null;
  organization: string | null;
}

type MaxMindReader<T extends Response> = Awaited<
  ReturnType<typeof maxmind.open<T>>
>;

let cityReaderPromise: Promise<MaxMindReader<CityResponse> | null> | undefined;
let asnReaderPromise: Promise<MaxMindReader<AsnResponse> | null> | undefined;
let cityModifiedAt = 0;
let asnModifiedAt = 0;

function openDatabase<T extends Response>(databasePath: string, edition: string) {
  return maxmind.open<T>(databasePath).catch((error: unknown) => {
    console.error(
      `${edition} database is invalid; continuing without this enrichment:`,
      error,
    );
    return null;
  });
}

export async function geolocateIp(ip: string): Promise<GeoResult> {
  const directory = getConfig().GEOLITE_DIR;
  const cityPath = path.join(directory, "GeoLite2-City.mmdb");
  const asnPath = path.join(directory, "GeoLite2-ASN.mmdb");

  const nextCityModifiedAt = fs.existsSync(cityPath)
    ? fs.statSync(cityPath).mtimeMs
    : 0;
  const nextAsnModifiedAt = fs.existsSync(asnPath)
    ? fs.statSync(asnPath).mtimeMs
    : 0;
  if (nextCityModifiedAt && nextCityModifiedAt !== cityModifiedAt) {
    cityReaderPromise = openDatabase<CityResponse>(cityPath, "GeoLite2-City");
    cityModifiedAt = nextCityModifiedAt;
  }
  if (nextAsnModifiedAt && nextAsnModifiedAt !== asnModifiedAt) {
    asnReaderPromise = openDatabase<AsnResponse>(asnPath, "GeoLite2-ASN");
    asnModifiedAt = nextAsnModifiedAt;
  }

  const [city, asn] = await Promise.all([
    cityReaderPromise?.then((reader) => reader?.get(ip) ?? null) ?? null,
    asnReaderPromise?.then((reader) => reader?.get(ip) ?? null) ?? null,
  ]);

  return {
    countryCode: city?.country?.iso_code ?? null,
    countryName: city?.country?.names?.en ?? null,
    city: city?.city?.names?.en ?? null,
    latitude: city?.location?.latitude ?? null,
    longitude: city?.location?.longitude ?? null,
    asn: asn?.autonomous_system_number ?? null,
    organization: asn?.autonomous_system_organization ?? null,
  };
}
