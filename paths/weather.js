/***************************
Simple example of a custom intercepted request, in which we contact a backend API and modify the 
results. Note that this example lacks the kind of error-handling you'd want to implement in 
practice.
***************************/

const https = require('https');
const url = require('url');

// ?lon=-96.79698789999999&lat=32.7766642
const WEATHER_URL = "https://www.7timer.info/bin/astro.php?ac=0&unit=british&output=json&tzshift=-6";

function callWeather(queryUrl){
    return new Promise( (resolve, reject) => {
        https.get(queryUrl, (response) => {
            let dataChunks = [];

			response.on('data', (fragments) => {
				dataChunks.push(fragments);
			});

			response.on('end', () => {
				let respBody = Buffer.concat(dataChunks);
                let jsonResponse = JSON.parse(respBody.toString());
                let temps = 0;
                let lowTemp = 9999;
                let highTemp = -9999;
                for(dp of jsonResponse.dataseries){
                    temps = temps + dp.temp2m;
                    if(dp.temp2m > highTemp){
                        highTemp = dp.temp2m;
                    }
                    if(dp.temp2m < lowTemp){
                        lowTemp = dp.temp2m;
                    }
                }
                jsonResponse["temp"] = {
                    "average" :temps / jsonResponse.dataseries.length,
                    "low" : lowTemp,
                    "high" : highTemp
                };
				resolve(JSON.stringify(jsonResponse));
			});

			response.on('error', (error) => {
				reject(error);
			});
        });
    });
}

module.exports["/v1/api/weather"] = {
    "to":function(req, res){
        var reqUrl = url.parse(req.url, true);
        var query = reqUrl.query;
        var queryUrl = WEATHER_URL;
        for(q in query){
            queryUrl = queryUrl + '&' + q + "=" + query[q];
        }
        console.log("Sending to " + queryUrl);
        var result = (async function(queryUrl){
            var innerResult = await callWeather(queryUrl);
            return innerResult;
        })(queryUrl);
        return result;
    },  
    "contentType":"application/json",
    "secure":false,
    "priority":1
};