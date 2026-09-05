import fs from "node:fs";
import path from "node:path";
import maxmind, { type AsnResponse, type CityResponse } from "maxmind";
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

let cityReaderPromise:
  | ReturnType<typeof maxmind.open<CityResponse>>
  | undefined;
let asnReaderPromise:
  | ReturnType<typeof maxmind.open<AsnResponse>>
  | undefined;
let cityModifiedAt = 0;
let asnModifiedAt = 0;

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
    cityReaderPromise = maxmind.open<CityResponse>(cityPath);
    cityModifiedAt = nextCityModifiedAt;
  }
  if (nextAsnModifiedAt && nextAsnModifiedAt !== asnModifiedAt) {
    asnReaderPromise = maxmind.open<AsnResponse>(asnPath);
    asnModifiedAt = nextAsnModifiedAt;
  }

  const [city, asn] = await Promise.all([
    cityReaderPromise?.then((reader) => reader.get(ip)) ?? null,
    asnReaderPromise?.then((reader) => reader.get(ip)) ?? null,
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
