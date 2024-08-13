import * as moment from "moment-timezone";
import * as geoTZ from "geo-tz";

import { GeoCoordinates, WeatherData, ZimmermanWateringData } from "../../types";
import { httpJSONRequest } from "../weather";
import { WeatherProvider } from "./WeatherProvider";
import { approximateSolarRadiation, CloudCoverInfo, EToData } from "../adjustmentMethods/EToAdjustmentMethod";
import { CodedError, ErrorCode } from "../../errors";

export default class OpenMeteoWeatherProvider extends WeatherProvider {

	/**
	 * Api Docs from here: https://open-meteo.com/en/docs
	 */
	public constructor() {
		super();
	}

	public async getWateringData( coordinates: GeoCoordinates ): Promise< ZimmermanWateringData > {
		//console.log("OM getWateringData request for coordinates: %s", coordinates);

		const yesterdayUrl = `https://api.open-meteo.com/v1/forecast?latitude=${ coordinates[ 0 ] }&longitude=${ coordinates[ 1 ] }&hourly=temperature_2m,relativehumidity_2m,precipitation&temperature_unit=fahrenheit&precipitation_unit=inch&timeformat=unixtime&past_days=1`;
		//console.log(yesterdayUrl);

		let yesterdayData;
		try {
			yesterdayData = await httpJSONRequest( yesterdayUrl );
		} catch ( err ) {
			console.error( "Error retrieving weather information from OpenMeteo:", err );
			throw new CodedError( ErrorCode.WeatherApiError );
		}

		if ( !yesterdayData.hourly ) {
			throw new CodedError( ErrorCode.MissingWeatherField );
		}

		let maxIndex: number = 0;

		const totals = { temp: 0, humidity: 0, precip: 0, raining: false };
		const now: number = moment().unix();

		for (let index = 0;  index < yesterdayData.hourly.time.length; index++ ) {
			if (yesterdayData.hourly.time[index] > now)
			{
				maxIndex = index-1;
				totals.raining = yesterdayData.hourly.precipitation[maxIndex] > 0 || yesterdayData.hourly.precipitation[index] > 0;
				break;
			}
			totals.temp += yesterdayData.hourly.temperature_2m[index];
			totals.humidity += yesterdayData.hourly.relativehumidity_2m[index];
			totals.precip += yesterdayData.hourly.precipitation[index]  || 0;
		}

		const result : ZimmermanWateringData = {
			weatherProvider: "OpenMeteo",
			temp: totals.temp / maxIndex,
			humidity: totals.humidity / maxIndex,
			precip: totals.precip,
			raining: totals.raining
		}
		/*console.log("OM 1: temp:%s humidity:%s precip:%s raining:%s",
			this.F2C(result.temp),
			result.humidity,
			this.inch2mm(result.precip),
			result.raining);*/
		return result;
	}

	public async getWeatherData( coordinates: GeoCoordinates ): Promise< WeatherData > {

		//console.log("OM getWeatherData request for coordinates: %s", coordinates);

		const currentDate: number = moment().unix();
		const timezone = geoTZ( coordinates[ 0 ], coordinates[ 1 ] )[ 0 ];

		const currentUrl = `https://api.open-meteo.com/v1/forecast?latitude=${ coordinates[ 0 ] }&longitude=${ coordinates[ 1 ] }&timezone=${ timezone }&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&current_weather=true&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&timeformat=unixtime`;
		//console.log(currentUrl);

		let current;
		try {
			current = await httpJSONRequest( currentUrl );
		} catch ( err ) {
			console.error( "Error retrieving weather information from OpenMeteo:", err );
			throw "An error occurred while retrieving weather information from OpenMeteo."
		}

		if ( !current || !current.daily || !current.current_weather ) {
			throw "Necessary field(s) were missing from weather information returned by OpenMeteo.";
		}

		const weather: WeatherData = {
			weatherProvider: "OpenMeteo",
			temp: current.current_weather.temperature,
			humidity: 0,
			wind: current.current_weather.windspeed,
			description: "",
			icon: this.getWMOIconCode(current.current_weather.weathercode),

			region: "",
			city: "",
			minTemp: current.daily.temperature_2m_min[0],
			maxTemp: current.daily.temperature_2m_max[0],
			precip: current.daily.precipitation_sum[0],
			forecast: [],
		};

		for ( let day = 0; day < current.daily.time.length; day++ ) {
			weather.forecast.push( {
				temp_min: current.daily.temperature_2m_min[day],
				temp_max: current.daily.temperature_2m_max[day],
				date: current.daily.time[day],
				icon: this.getWMOIconCode( current.daily.weathercode[day] ),
				description: "",
			} );
		}

		/*console.log("OM 2: temp:%s humidity:%s wind:%s",
			this.F2C(weather.temp),
			weather.humidity,
			this.mph2kmh(weather.wind));*/

		return weather;
	}

	public async getEToData( coordinates: GeoCoordinates ): Promise< EToData > {
		//console.log("OM getEToData request for coordinates: %s", coordinates);

		const timestamp: string = moment().subtract( 1, "day" ).format();
		const timezone = geoTZ( coordinates[ 0 ], coordinates[ 1 ] )[ 0 ];
		const historicUrl = `https://api.open-meteo.com/v1/forecast?latitude=${ coordinates[ 0 ] }&longitude=${ coordinates[ 1 ] }&timezone=${ timezone }&hourly=temperature_2m,relativehumidity_2m,precipitation,direct_radiation,windspeed_10m&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&timeformat=unixtime&past_days=1`;
		//console.log(historicUrl);

		let historicData;
		try {
			historicData = await httpJSONRequest( historicUrl );
		} catch (err) {
			throw new CodedError( ErrorCode.WeatherApiError );
		}

		if ( !historicData || !historicData.hourly ) {
			throw "Necessary field(s) were missing from weather information returned by Bright Sky.";
		}

		let minHumidity: number = undefined, maxHumidity: number = undefined;
		let minTemp: number = undefined, maxTemp: number = undefined, precip: number = 0;
		let wind: number = 0, solar: number = 0;
		let maxIndex: number = 0;
		const now: number = moment().unix();
		for (let index = 0;  index < historicData.hourly.time.length; index++ ) {
			if (historicData.hourly.time[index] > now)
			{
				maxIndex = index-1;
				break;
			}

			minTemp = minTemp < historicData.hourly.temperature_2m[index] ? minTemp : historicData.hourly.temperature_2m[index];
			maxTemp = maxTemp > historicData.hourly.temperature_2m[index] ? maxTemp : historicData.hourly.temperature_2m[index];

			precip += historicData.hourly.precipitation[index];
			if (historicData.hourly.windspeed_10m[index] > wind)
				wind = historicData.hourly.windspeed_10m[index];

			minHumidity = minHumidity < historicData.hourly.relativehumidity_2m[index] ? minHumidity : historicData.hourly.relativehumidity_2m[index];
			maxHumidity = maxHumidity > historicData.hourly.relativehumidity_2m[index] ? maxHumidity : historicData.hourly.relativehumidity_2m[index];

			solar += historicData.hourly.direct_radiation[index];
		}

		solar = solar / maxIndex * 24 / 1000;
		const result : EToData = {
			weatherProvider: "OpenMeteo",
			periodStartTime: historicData.hourly.time[0],
			minTemp: minTemp,
			maxTemp: maxTemp,
			minHumidity: minHumidity,
			maxHumidity: maxHumidity,
			solarRadiation: solar,
			windSpeed: wind,
			precip: precip,
		}
		/*console.log("OM 3: precip:%s solar:%s minTemp:%s maxTemp:%s minHum:%s maxHum:%s wind:%s from:%s maxIdx:%s",
			precip.toPrecision(3),
			solar.toPrecision(3),
			this.F2C(minTemp), this.F2C(maxTemp), minHumidity, maxHumidity, this.mph2kmh(wind), moment.unix(historicData.hourly.time[0]).format(), maxIndex);*/
		return result;
	}

	public shouldCacheWateringScale(): boolean {
		return true;
	}

	/**
	 * See https://open-meteo.com/en/docs
	 * @param code
	 * @returns
	 */
	private getWMOIconCode(code: number) {
		switch(code) {
			case 0:
				return "01d"; //Clear Sky
			case 1:
			case 2:
			case 3:
				return "02d"; //Mainly clear, partly cloudy, and overcast
			case 45:
			case 48:
				return "50d"; //Fog and depositing rime fog
			case 51:
			case 53:
			case 55:
				return "09d"; //Drizzle: Light, moderate, and dense intensity
			case 56:
			case 57:
				return "09d"; //Freezing Drizzle: Light and dense intensity
			case 61:
			case 63:
			case 65:
				return "10d"; //Rain: Slight, moderate and heavy intensity
			case 66:
			case 67:
				return "10d"; //Freezing Rain: Light and heavy intensity
			case 71:
			case 73:
			case 75:
				return "13d"; //Snow fall: Slight, moderate, and heavy intensity
			case 77:
				return "13d"; //Snow grains
			case 80:
			case 81:
			case 82:
				return "10d"; //Rain showers: Slight, moderate, and violent
			case 85:
			case 86:
				return "13d"; //Snow showers slight and heavy
			case 95:
				return "11d"; //Thunderstorm: Slight or moderate
			case 96:
			case 99:
				return "11d"; // Thunderstorm with slight and heavy hail
			default:
				return "01d";
		}
	}

	//Grad Celcius to Fahrenheit:
	private C2F(celsius: number): number {
		return celsius * 1.8 + 32;
	}

	//kmh to mph:
	private kmh2mph(kmh : number): number {
		return kmh / 1.609344;
	}

	//mm to inch:
	private mm2inch(mm : number): number {
		return mm / 25.4;
	}

	// Fahrenheit to Grad Celcius:
	private F2C(fahrenheit: number): number {
		return (fahrenheit-32) / 1.8;
	}

	//mph to kmh:
	private mph2kmh(mph : number): number {
		return mph * 1.609344;
	}

	//inch to mm:
	private inch2mm(inch : number): number {
		return inch * 25.4;
	}
}
