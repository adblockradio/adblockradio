const { log } = require("abr-log")("predictor-status");
const Predictor = require("./predictor.js");
const { Transform } = require("stream");

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

class Status extends Transform {
    constructor() {
        super({ writableObjectMode: true, readableObjectMode: true });
        this.cache = [];
        this._postProcessing = this._postProcessing.bind(this);
        this.slotCounter = 0;
    }

    _write(data, enc, next) {
        if (!this.cache[0]) this._newCacheSlot(0);

        switch (data.type) {
            case "audio":
                if (data.newSegment && this.cache[0] && this.cache[0].audio && this.cache[0].audio.length > 0) {
                    log.info("audio => " + this.cache[0].audio.length + " bytes, tBuf=" + data.tBuffer.toFixed(2) + "s");
                    this._newCacheSlot(data.tBuffer);
                }
                this.cache[0].audio = this.cache[0].audio ? Buffer.concat([ this.cache[0].audio, data.data ]) : data.data;
                break;

            case "ml":
                log.info("ml => type=" + consts.WLARRAY[data.data.type] + " confidence=" + data.data.confidence.toFixed(2));
                if (this.cache[0].ml) log.warn("overwriting ml cache data!")
                this.cache[0].ml = data.data;
                this.cache[0].gain = data.data.gain;
                break;

            case "hotlist":
                log.info("hotlist => matches=" + data.data.matchesSync + "/" + data.data.matchesTotal + " class=" + consts.WLARRAY[data.data.class]);
                if (this.cache[0].hotlist) log.warn("overwriting hotlist cache data!")
                this.cache[0].hotlist = data.data;
                break;

            case "title":
                log.info("title => " + JSON.stringify(data.data));

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
        setTimeout(this._postProcessing, tBuffer*1000, now);

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
                if (ic == 0) log.debug("i=" + i + " cacheLen=" + this.cache.length + " availPast=" + availableSlotsPast + " availFut=" + availableSlotsFuture + " j=" + j + " ml?=" + !!(this.cache[i + availableSlotsPast - j].ml));
                if (this.cache[i + availableSlotsPast - j].ml && this.cache[i + availableSlotsPast - j].ml.softmaxs[0]) {
                    movAvg[ic] += this.cache[i + availableSlotsPast - j].ml.softmaxs[0][ic] * consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights[j];
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
        const mlConfident = maxMovAvg > 0.65;
        log.debug("movAvg: slot n=" + this.cache[i].n + " i=" + i + " movAvg=" + movAvg + " confident=" + mlConfident);
        
        // pruning of unclear hotlist detections
        const hlConfident = this.cache[i].hotlist.matchesTotal >= 10 && this.cache[i].hotlist.matchesSync / this.cache[i].hotlist.matchesTotal > 0.2

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
            }
        });

        /*if (!this.cache[i].ml) {
            return log.warn("_postProcessing: i=" + i + " n=" + this.cache[i].n + " no ml softmaxs to process");
        }*/

        /*for (let ic = 0; ic < movAvg.length; ic++) {
            movAvg[ic] = this.cache.slice(i - availableSlotsFuture, i + availableSlotsPast)
                .map(e => e.ml.softmaxs[0][ic] * consts.MOV_AVG_WEIGHTS[availableSlotsFuture].weights.reverse())
                .reduce((accumulator, currentValue) => accumulator + currentValue);
            log.debug("movAvg: i=" + i + " n=" + this.cache[i].n + " movAvg=" + movAvg[ic] + " from " + this.cache.slice(i - availableSlotsFuture, i + availableSlotsPast).map(e => e.ml.softmaxs[0][ic]));
        }*/
    }
}

const status = new Status();

status.on("data", function(obj) {
    log.info("status=" + JSON.stringify(Object.assign(obj, { audio: obj.audio.length }), null, "\t"));
});

const predictor = new Predictor({
    country: "France",
    name: "RTL",
    predictor: { ml: true, hotlist: true },
    listener: status
});