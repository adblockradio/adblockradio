const { log } = require("abr-log")("post-processing");
const Predictor = require("./predictor.js");
const { Transform, Readable } = require("stream");

const consts = {
    WLARRAY: ["0-ads", "1-speech", "2-music", "3-jingles"],
    CACHE_MAX_LEN: 50,
    MOV_AVG_WEIGHTS: [
        {"weights": [0.05, 0.05, 0.05, 0.10, 0.10, 0.15, 0.20, 0.30, 0.80, 1.00], "sum": 2.80 }, // r=0 same as ideal r=1 for very short buffers. so 1 step lag
        {"weights": [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.70, 0.80, 1.00], "sum": 4.30 }, // r=1 same as ideal r=2 for short buffers. so 1 step lag
        {"weights": [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.70, 0.80, 1.00], "sum": 4.30 }, // r=2
        {"weights": [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00], "sum": 5.50 }, // r=3
        {"weights": [0.25, 0.35, 0.50, 0.70, 0.90, 1.00, 1.00, 0.80, 0.70, 0.20], "sum": 6.20 }  // r=4
    ]
}

class PostProcessor extends Transform {
    constructor() {
        super({ writableObjectMode: true, readableObjectMode: true });
        this.cache = [];
        this._postProcessing = this._postProcessing.bind(this);
        this.slotCounter = 0;
    }

    _write(obj, enc, next) {
        if (!this.cache[0]) this._newCacheSlot(0);

        switch (obj.type) {
            case "audio":
                if (obj.newSegment && this.cache[0] && this.cache[0].audio && this.cache[0].audio.length > 0) {
                    log.info("audio => " + this.cache[0].audio.length + " bytes, tBuf=" + obj.tBuffer.toFixed(2) + "s");
                    this._newCacheSlot(obj.tBuffer);
                }
                this.cache[0].audio = this.cache[0].audio ? Buffer.concat([ this.cache[0].audio, obj.data ]) : obj.data;
                break;

            case "ml":
                log.info("ml => type=" + consts.WLARRAY[obj.data.type] + " confidence=" + obj.data.confidence.toFixed(2) + " softmax=" + data.data.softmaxs.map(e => e.toFixed(2)) + " confidence=" + data.data.confidence.toFixed(2));
                if (this.cache[0].ml) log.warn("overwriting ml cache data!")
                this.cache[0].ml = obj.data;
                this.cache[0].gain = obj.data.gain;
                break;

            case "hotlist":
                log.info("hotlist => matches=" + obj.data.matchesSync + "/" + obj.data.matchesTotal + " class=" + consts.WLARRAY[data.data.class]);
                if (this.cache[0].hotlist) log.warn("overwriting hotlist cache data!")
                this.cache[0].hotlist = obj.data;
                break;

            case "title":
                log.info("title => " + JSON.stringify(obj.data));
                // TODO save title

            case "dlinfo":
                log.info("dlinfo => " + JSON.stringify(obj.data));
                // TODO save dlinfo

            default:
                log.info(JSON.stringify(data));
        }
        
        next();
    }

    _newCacheSlot(tBuffer) {

        const now = +new Date();
        this.slotCounter++;
        this.cache.unshift({ ts: now, audio: null, ml: null, hotlist: null, tBuf: tBuffer, n: this.slotCounter });
        
        // schedule the postprocessing for this slot, according to the buffer available.
        // "now" is used as a reference for _postProcessing, so it knows which slot to process
        // postProcessing happens 500ms before audio playback, so that clients / players have time to act.
        setTimeout(this._postProcessing, tBuffer*1000-500, now);

        if (this.cache.length > consts.CACHE_MAX_LEN) this.cache.pop();
    }

    _postProcessing(tsRef) {
        const i = this.cache.map(e => e.ts).indexOf(tsRef);
        if (i < 0) return log.warn("_postProcessing: cache item not found");
        
        const availableSlotsFuture = Math.min(i, 4); // consts.MOV_AVG_WEIGHTS supports up to 4 slots in the future.
        const availableSlotsPast = Math.min(this.cache.length - 1 - i, consts.MOV_AVG_WEIGHTS[0].weights.length - availableSlotsFuture - 1); // verification: first slot ever (i=0, cache.len=1) leads to zero past slots.
        
        /*if (availableSlotsFuture + availableSlotsPast < 10) {
            return log.warn("_postProcessing: i=" + i + " n=" + this.cache[i].n + " not enough cache. future=" + availableSlotsFuture + " past=" + availableSlotsPast);
        }*/

        // smoothing over time of ML predictions.
        let movAvg = new Array(3);
        let iMaxMovAvg = 0;
        let maxMovAvg = 0;
        for (let ic = 0; ic < movAvg.length; ic++) {
            movAvg[ic] = 0;
            let sum = 0;
            for (let j = 0; j <= availableSlotsPast + availableSlotsFuture; j++) {
                //if (ic == 0) log.debug("i=" + i + " cacheLen=" + this.cache.length + " availPast=" + availableSlotsPast + " availFut=" + availableSlotsFuture + " j=" + j + " ml?=" + !!(this.cache[i + availableSlotsPast - j].ml));
                if (this.cache[i + availableSlotsPast - j].ml && this.cache[i + availableSlotsPast - j].ml.softmaxs) {
                    if (ic == 0 && isNaN(this.cache[i + availableSlotsPast - j].ml.softmaxs[ic])) log.warn("this.cache[i + availableSlotsPast - j].ml.softmaxs[ic] is NaN. i=" + i + " availableSlotsPast=" + availableSlotsPast + " j=" + j + " ic=" + ic);
                    if (ic == 0 && isNaN(consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j])) log.warn("consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j] is NaN. availableSlotsFuture=" + availableSlotsFuture + " j=" + j);
                    movAvg[ic] += this.cache[i + availableSlotsPast - j].ml.softmaxs[ic] * consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j];
                    sum += consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j];
                }
            }
            movAvg[ic] = sum ? (movAvg[ic] / sum) : null;
            if (movAvg[ic] && movAvg[ic] > maxMovAvg) {
                maxMovAvg = movAvg[ic];
                iMaxMovAvg = ic;
            }
        }

        // pruning of unsure ML predictions
        // 	confidence = 1.0-math.exp(1-mp[2]/mp[1])
        const mlConfident = maxMovAvg > 0.65;
        log.debug("movAvg: slot n=" + this.cache[i].n + " i=" + i + " movAvg=" + movAvg + " confident=" + mlConfident);
        
        // pruning of unclear hotlist detections
        const hlConfident = this.cache[i].hotlist.matchesTotal >= 10 && this.cache[i].hotlist.matchesSync / this.cache[i].hotlist.matchesTotal > 0.2

        let finalClass;
        if (hlConfident) {
            finalClass = consts.WLARRAY[this.cache[i].hotlist.class];
        } else if (mlConfident) {
            finalClass = consts.WLARRAY[iMaxMovAvg];
        } else {
            finalClass = "unsure";
        }

        // final output
        this.push({
            audio: this.cache[i].audio,
            gain: this.cache[i].gain,
            ml: {
                class: mlConfident ? consts.WLARRAY[iMaxMovAvg] : "unsure",
                softmax: movAvg,
            },
            hotlist: {
                class: hlConfident ? consts.WLARRAY[this.cache[i].hotlist.class] : "unsure",
                file: this.cache[i].hotlist.file
            },
            class: finalClass
        });
    }
}


class Analyser extends Readable {
    constructor(options) {
        super({ objectMode: true });

        this.country = options.country;
        this.name = options.name;

        const postProcessor = new PostProcessor();

        const self = this;
        postProcessor.on("data", function(obj) {
            self.push(Object.assign(obj, {
                country: self.country,
                name: self.name,
                audioLen: obj.audio.length
            }));
        });

        const predictor = new Predictor({
            country: self.country,
            name: self.name,
            config: options.config,
            listener: postProcessor
        });
    }

    newPredictChild() {
        // TODO
    }

    stopDl() {
        // TODO
    }

    _read() {
        // nothing
    }
}

exports.PostProcessor = PostProcessor
exports.Analyser = Analyser;