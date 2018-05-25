const AdblockRadio = require("./predictor-status");
const { log } = require("abr-log")("demo");

const abr = new AdblockRadio({
    country: "France",
    name: "RTL",
    config: {
        predictor: { 
            ml: true, 
            hotlist: true
        },
        predInterval: 1,
        saveDuration: 10,
        saveAudio: true,
		saveMetadata: true,
		fetchMetadata: true
    }
});

abr.on("data", function(obj) {
    log.info("status=" + JSON.stringify(Object.assign(obj, { audio: undefined }), null, "\t"));
});