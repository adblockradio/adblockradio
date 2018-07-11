const { log } = require("abr-log")("demo");
const { Analyser } = require("./post-processing.js");

log.info("start analyser!");

const abr = new Analyser({
	country: "France",
	name: "RTL",
	config: {
		predInterval: 1,
		saveDuration: 10,
		enablePredictorHotlist: true,
		enablePredictorMl: true,
		saveAudio: true,
		saveMetadata: true,
		fetchMetadata: true,
		verbose: true,
	}
});

abr.on("data", function(obj) {
	log.info("status=" + JSON.stringify(Object.assign(obj, { audio: undefined }), null, "\t"));
});
