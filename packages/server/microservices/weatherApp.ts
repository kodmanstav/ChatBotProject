import {
   createConsumer,
   createProducer,
   safeJsonParse,
   sendJson,
   runConsumer,
} from './shared/kafka';
import { TOPICS } from './shared/topics';

type WeatherIntent = { city: string };

function hasHebrew(text: string): boolean {
   return /[\u0590-\u05FF]/.test(text);
}

async function geocode(
   city: string,
   language: 'en' | 'he'
): Promise<{
   name: string;
   latitude: number;
   longitude: number;
   admin1?: string;
   country?: string;
} | null> {
   const url =
      'https://geocoding-api.open-meteo.com/v1/search?' +
      new URLSearchParams({
         name: city,
         count: '1',
         language,
         format: 'json',
      });

   const res = await fetch(url);
   if (!res.ok) return null;
   const data = (await res.json()) as any;

   const r = data?.results?.[0];
   if (!r) return null;

   return {
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      admin1: r.admin1,
      country: r.country,
   };
}

async function fetchWeather(
   lat: number,
   lon: number
): Promise<{ temp: number; wind?: number; code?: number } | null> {
   const url =
      'https://api.open-meteo.com/v1/forecast?' +
      new URLSearchParams({
         latitude: String(lat),
         longitude: String(lon),
         current: 'temperature_2m,wind_speed_10m,weather_code',
         timezone: 'auto',
      });

   const res = await fetch(url);
   if (!res.ok) return null;
   const data = (await res.json()) as any;

   const temp = data?.current?.temperature_2m;
   const wind = data?.current?.wind_speed_10m;
   const code = data?.current?.weather_code;

   if (typeof temp !== 'number') return null;

   return {
      temp,
      wind: typeof wind === 'number' ? wind : undefined,
      code: typeof code === 'number' ? code : undefined,
   };
}

function weatherCodeToText(code: number, lang: 'he' | 'en'): string {
   const he: Record<number, string> = {
      0: 'שמשי',
      1: 'בהיר ברובו',
      2: 'מעונן חלקית',
      3: 'מעונן',
      45: 'ערפל',
      48: 'ערפל קפוא',
      51: 'טפטוף קל',
      53: 'טפטוף',
      55: 'טפטוף חזק',
      61: 'גשם קל',
      63: 'גשם',
      65: 'גשם חזק',
      71: 'שלג קל',
      73: 'שלג',
      75: 'שלג כבד',
      80: 'ממטרים קלים',
      81: 'ממטרים',
      82: 'ממטרים חזקים',
      95: 'סופת רעמים',
   };

   const en: Record<number, string> = {
      0: 'Sunny',
      1: 'Mostly clear',
      2: 'Partly cloudy',
      3: 'Cloudy',
      45: 'Fog',
      48: 'Freezing fog',
      51: 'Light drizzle',
      53: 'Drizzle',
      55: 'Heavy drizzle',
      61: 'Light rain',
      63: 'Rain',
      65: 'Heavy rain',
      71: 'Light snow',
      73: 'Snow',
      75: 'Heavy snow',
      80: 'Light showers',
      81: 'Showers',
      82: 'Heavy showers',
      95: 'Thunderstorm',
   };

   return (
      (lang === 'he' ? he : en)[code] ?? (lang === 'he' ? 'לא ידוע' : 'Unknown')
   );
}

const producer = await createProducer('weather-producer');
const consumer = await createConsumer(
   'weather-consumer',
   'weather-consumer-intent-weather'
);

await runConsumer(consumer, TOPICS.INTENT_WEATHER, async ({ message }) => {
   const userId = message.key?.toString() ?? '';
   const parsed = safeJsonParse<WeatherIntent>(message.value?.toString() ?? '');
   if (!userId || !parsed) return;

   const cityRaw = (parsed.city ?? '').trim();
   const lang: 'he' | 'en' = hasHebrew(cityRaw) ? 'he' : 'en';

   let result =
      lang === 'he'
         ? `לא הצלחתי להביא מזג אוויר עבור "${cityRaw}".`
         : `I couldn't fetch weather information for "${cityRaw}".`;

   const firstLang = lang === 'he' ? ('he' as const) : ('en' as const);
   const secondLang = firstLang === 'he' ? ('en' as const) : ('he' as const);

   const geo =
      (await geocode(cityRaw, firstLang)) ??
      (await geocode(cityRaw, secondLang));

   if (geo) {
      const w = await fetchWeather(geo.latitude, geo.longitude);
      if (w) {
         const name = geo.name.trim();
         const admin = (geo.admin1 ?? '').trim();

         const place =
            admin && admin.toLowerCase() !== name.toLowerCase()
               ? `${name}, ${admin}`
               : name;
         const desc =
            typeof w.code === 'number' ? weatherCodeToText(w.code, lang) : null;

         if (lang === 'he') {
            result = `${place}: ${w.temp}°C${desc ? `, ${desc}` : ''}${
               typeof w.wind === 'number' ? `, רוח ${w.wind} קמ"ש` : ''
            }`;
         } else {
            result = `${place}: ${w.temp}°C${desc ? `, ${desc}` : ''}${
               typeof w.wind === 'number' ? `, wind ${w.wind} km/h` : ''
            }`;
         }
      }
   }

   await sendJson(producer, TOPICS.APP_RESULTS, userId, {
      type: 'weather',
      result,
   });
   console.log(`[WEATHER] (${userId}) ${cityRaw}`);
});
