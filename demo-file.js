const { log } = require("abr-log")("demo-file");
const { Analyser } = require("./post-processing.js");

log.info("start analyser!");

const abr = new Analyser({
	country: "France",
	name: "RTL",
	config: {
		file: "files/merge-short.mp3",
		predInterval: 1,
		enablePredictorHotlist: true,
		enablePredictorMl: true,
		saveMetadata: true,
		verbose: true,
	}
});

abr.on("data", function(obj) {
	log.info("status=" + JSON.stringify(Object.assign(obj, { audio: undefined }), null, "\t"));
});
