var consts = require("./util_consts");
var log = consts.log("mrs/dsp");

var lame = require("lame");
var dsp = require('./dsp.js');
var countDiff = require("./util_countdiff.js");

var DEBUG = false;

var setDebugMode = function() {
	DEBUG = true;
}

// DSP functions

var downSample = function(audio, sampleRate, channels, bitDepth, targetSampleRate) {
	
	if (Math.round(sampleRate/targetSampleRate)*targetSampleRate != sampleRate) {
		log("downsample: only integer initFs/outFs are supported: " + sampleRate + " vs " + targetSampleRate, consts.LOG_ERROR);
		return null;
	}
	if (bitDepth != 16) {
		log("downsample: only 16 bit audio is supported", consts.LOG_ERROR);
		return null;
	}
	
	// down sample - note: it would be good to low pass filter before, but quick & dirty tests suggested it was not necessary.
	var skipBytes = sampleRate / targetSampleRate * channels * (bitDepth/8);
	var movAvgWin = sampleRate / targetSampleRate;
	var nSamples = audio.length/skipBytes - Math.ceil(movAvgWin/sampleRate * targetSampleRate);
	for (var i=0; i<nSamples; i++) {
		var tmp = 0;
		for (var j=0; j<movAvgWin; j++) { // moving average. dirty but OK enough.
			tmp += audio.readInt16LE(i*skipBytes + channels * (bitDepth/8) * j);
		}
		tmp = Math.round(tmp / movAvgWin);
		audio.writeInt16LE(tmp, 2*i);
	}
	return audio.slice(0, 2*nSamples);
		
}

var decode = function(rowsById, ids, sampling, callback) {
	var decoder = new lame.Decoder();
	var audio = new Buffer(0);
	var nsegReceived = 0;
	var format = new Object();
	var abort = false;
	
	decoder.on("format", function(obj) {
		format = obj;
		// format checks
		if (Math.round(obj.sampleRate/sampling)*sampling != obj.sampleRate) {
			log("WARNING, bad sampling rate = " + obj.sampleRate, consts.LOG_WARN); // easier if sample rate is a multiple of 11025 Hz
		}
		if (obj.bitDepth != 16) {
			log("WARNING, bit depth is not 16, instead = " + obj.bitDepth, consts.LOG_WARN);
		}
		if (obj.ulaw || obj.alaw) {
			log("WARNING, log pcm", consts.LOG_WARN);
		}
		
		skipBytes = Math.round(obj.sampleRate/sampling) * obj.channels; // should be 8 because 44100Hz stereo.	
	});
	
	decoder.on("data", function(data) {
		if (abort) return;
		audio = Buffer.concat([audio, data]);
		if (data.length < 73728) {
			nsegReceived += 1;
		}
		if (nsegReceived >= ids.length) {
			if (DEBUG) log("lame decoder received total " + audio.length + " bytes", consts.LOG_DEBUG);
			callback(null, downSample(audio, format.sampleRate, format.channels, format.bitDepth, sampling));
		} else if (data.length < 73728) {
			write(nsegReceived);
		}
	});
	
	decoder.on("error", function(err) {
		if (DEBUG) log("decode: decoder threw an error: " + err, consts.LOG_WARN);
	});
	
	var write = function(i) {
		try {
	//	for (var i=0; i<ids.length; i++) {
			decoder.write(rowsById[ids[i]].audioData);
	//	}	
		} catch (e) {
			log("WARNING, could not decode MRS audio: " + e.toString(), consts.LOG_WARN);
			callback(e, null);
			abort = true;
		}
	}
	write(0);
}

// Output to speakers
/*var speak = function(buffer, samplingRate) {					
	var Speaker = require('speaker');
	var speaker = new Speaker({	channels: 1, bitDepth: 16, sampleRate: samplingRate	});
	speaker.write(buffer);
}*/


var xcorrFFT = function(sig1, sig2, sampling) { // ring correlation with FFT, fast & enough for what is done here. assumes sig1 & sig2 are 16-bit pcm buffers of same length.
				
	if (sig1.length != sig2.length) {
		log("xcorr: signals have different lengths: " + sig1.length + " vs " + sig2.length + ". Abort.", consts.LOG_ERROR);
		return null;
	}
	
	var sig1arr = new Array(sig1.length/2);
	var sig2arr = new Array(sig1.length/2);
	var l = sig1arr.length;
	var rms1=0; rms2=0;
	
	for (var i=0; i<l; i++) {
		sig1arr[i] = sig1.readInt16LE(2*i);
		sig2arr[i] = sig2.readInt16LE(2*i);
		rms1 += Math.pow(sig1arr[i],2);
		rms2 += Math.pow(sig2arr[i],2);
	}
	rms1 = Math.sqrt(rms1/l);
	rms2 = Math.sqrt(rms2/l);

	var fft1 = new dsp.FFT(l, sampling);
	fft1.forward(sig1arr);
	var real1 = fft1.real, imag1 = fft1.imag;
	
	var fft2 = new dsp.FFT(l, sampling);
	fft2.forward(sig2arr);
	var real2 = fft2.real, imag2 = fft2.imag;
	
	var realp = new Array(l), imagp = new Array(l);
	for (var i=0; i<l; i++) { // dot product of the spectra.
		realp[i] = real1[i] * real2[i] + imag1[i] * imag2[i];
		imagp[i] = - real1[i] * imag2[i] + real2[i] * imag1[i]; // we take the complex conjugate of fft2.
	}
	
	var fftp = new dsp.FFT(l, sampling);
	var result = fftp.inverse(realp, imagp);
				
	// get the max of the spectrum
	var maxC = 0, tMaxC = 0, rmsTmp = 0;
	for (var i=0; i<l; i++) {
		result[i] = result[i] / rms1 / rms2 / l;
		if (Math.abs(result[i]) > maxC) {
			maxC = Math.abs(result[i]);
			tMaxC = i;
			rmsTmp += Math.pow(result[i],2);
		}
	}
	var rms = Math.sqrt(rmsTmp/l);
	if (false && DEBUG) log("max corr FFT    found at t=" + tMaxC + "/" + l + " C=" + (Math.round(maxC*1000)/1000) + " rms=" + Math.round(rms*1000)/1000, consts.LOG_DEBUG);
	
	/* Plot crosscorrelation profiles
	var plot = require("./util_plot.js");
	var imgW = 1024, imgH = 1024;
	var img = plot.newPng(imgW,imgH);
							
	for (var x=0; x<imgW; x++) {
		//log("draw marker x=" + x + " y=" + boundaries.repFun[Math.round((boundaries.nt-1)*x/(imgW-1))] + " at t=" + Math.round((boundaries.nt-1)*x/(imgW-1)));
		plot.drawMarker(img, x, Math.round(imgH*(0.5+0.50*xc.xcorr[Math.round(x*(beforeT1+afterT1)/imgW)])), 2);
	}
	plot.savePng(img, "xcorr.png");*/	
	
	return {"xcorr":result, "tmax":tMaxC, "max":maxC, "rms":rms };
}

var detectXcorrSteps = function(audio1, audio2, init1, init2, freedoms, sampling) {
	// init1/2 = { "start": .. , "stop": .. } contain 2*byte indexes inside audio buffers. ie init1:2 < audio1:2.length / 2
	// freedoms is "L" if we want to optimize the start of the common audio. "R" for the end of the common audio. "LR" if we look for both.
	// will always look for values further than the corresponding start/stop value given as a parameter, so as to expand the current common audio.

	var EDGE_DT = 4;

	var heavisideCost = function(mxc, t1, t2) {
		var threshold = 0.50;
		var cost = 0;
		for (var i=0; i<t1; i++) {
			cost += Math.pow(mxc[i]/threshold,2);
		}
		for (var i=t1; i<t2; i++) {
			cost += Math.pow((1-mxc[i])/(1-threshold),2);
		}
		for (var i=t2; i<mxc.length; i++) {
			cost += Math.pow(mxc[i]/threshold,2);
		}
		return cost;
	}
	
	var lookLeft = freedoms.indexOf("L") >= 0;
	var lookRight = freedoms.indexOf("R") >= 0;
	
	var widthT = 8192; // xcorr window size, defines the resolution (s) = widthT / sampling
	var stepT = widthT / 4; // step size.
	var result = { "err": null, "expandDirections": "" };
	
	if (lookLeft) {
		var room = Math.min(init1.start, init2.start)-widthT;
		var nWin = Math.floor(room / stepT);
		if (DEBUG) log("room left=" + (room/sampling) + " s & nWin=" + nWin);
		if (nWin <= 1) {
			result.expandDirections += "L";
			//return {"error":"not enough room at left"};
		} else {
			var mxc = new Array(nWin);
			for (var i=0; i<nWin; i++) {
				var b1 = init1.start - (nWin-1-i)*stepT;
				var b2 = init2.start - (nWin-1-i)*stepT;
				mxc[i] = xcorrFFT(audio1.slice(2*(b1-widthT), 2*b1), audio2.slice(2*(b2-widthT), 2*b2), sampling).max;
				//log("mxc i=" + (nWin-1-i) + " val=" + mxc[nWin-1-i]);
			}
			
			var minCost = heavisideCost(mxc, nWin, nWin);
			var iminCost = nWin;
			for (var i=nWin-1; i>=0; i--) {
				var cost = heavisideCost(mxc, i, nWin);
				//log("test cost at i=" + i + " cost=" + cost);
				if (cost < minCost) {
					minCost = cost;
					iminCost = i;
				}
			}
			if (DEBUG) log("iminCost=" + iminCost + " vs nWin=" + nWin);
			init1.start = Math.round(init1.start - (nWin-1-iminCost) * stepT - widthT / 2);
			init2.start = Math.round(init2.start - (nWin-1-iminCost) * stepT - widthT / 2);
		
			room = Math.min(init1.start, init2.start)-widthT;
			if (room/sampling < EDGE_DT) {
				result.expandDirections += "L";
			}
			if (DEBUG) log("final room left=" + (room/sampling) + " s");
			
		}
		//if (result.expandDirections.indexOf("L") >= 0) {

			

	}
	
	if (lookRight) {
		var room = Math.min((audio1.length-2)/2-init1.stop, (audio2.length-2)/2-init2.stop)-widthT;
		var nWin = Math.floor(room / stepT);
		if (DEBUG) log("room right=" + (room/sampling) + " s & nWin=" + nWin);
		if (nWin <= 1) {
			result.expandDirections += "R";
			//return {"error":"not enough room at right"};
		} else {
			var mxc = new Array(nWin);
			for (var i=0; i<nWin; i++) {
				var b1 = init1.stop + i*stepT;
				var b2 = init2.stop + i*stepT;
				mxc[i] = xcorrFFT(audio1.slice(2*b1, 2*(b1+widthT)), audio2.slice(2*b2, 2*(b2+widthT)), sampling).max;
			}
			
			var minCost = heavisideCost(mxc, 0, 0);
			var iminCost = 0;
			for (var i=1; i<nWin; i++) {
				var cost = heavisideCost(mxc, 0, i);
				if (cost < minCost) {
					minCost = cost;
					iminCost = i;
				}
			}
			init1.stop = Math.round(init1.stop + iminCost * stepT + widthT / 2);
			init2.stop = Math.round(init2.stop + iminCost * stepT + widthT / 2);
		}
		
		room = Math.min((audio1.length-2)/2-init1.stop, (audio2.length-2)/2-init2.stop)-widthT;
		if (room/sampling < EDGE_DT && result.expandDirections.indexOf("R") == -1) {
			result.expandDirections += "R";
		}
		if (DEBUG) log("final room right=" + (room/sampling) + " s");
	}
	return result; // result is stored in init1 & init2 objects	
}

var bootstrapComparison = function(radioName, rowsById, from, to) {

	var frFP = rowsById[from].fp;
	var toFP = rowsById[to].fp;	
						
	var toFPdt = new Array(toFP.length);
	var frFPdt = new Array(frFP.length);
	var admatches = (new Array(toFP.length));

	for (var i=0, limit=toFP.length; i<limit; i++) {// += step2) { , step2=Math.ceil(toFP.length/1000)
		toFPdt[i] = Math.round(toFP[i].dt);
		admatches[i] = [];
		for (var j=0, limit2=frFP.length; j<limit2; j++) {// += step3) { , step3=Math.ceil(frFP.length/1000)
			if (frFP[j].finger == toFP[i].finger) {
				admatches[i].push(frFP[j]);
			}
		}
	}
						
	var results = { largest_count: 0, total_count: 0, top_ad: -1, top_diff: 0, top_whitelist: 0, diff_counter: new Object() };
	countDiff(toFPdt, admatches, results, 1, false, radioName);

	// times of the fingerprints in the current audio that have lead to the largest count. useful to know which part of the audio is responsible of the detection.
	var tDetect = [];
	for (var i=0; i < admatches.length; i++) {
		for (var j=0; j < admatches[i].length; j++) {
			//if (admatches[i][j].ad == results.top_ad) {
			tDetect.push(toFPdt[i]);
			//}
		}
	}
	if (DEBUG) log("tDetect len=" + tDetect.length);
	
	// build the repartition function
	var nt = Math.round((consts.FLAG_DT_PRE + consts.FLAG_DT_POST) / consts.FINGERS_DT);
	var tExp = new Array(nt).fill(0);
	for (var i=0, limit=tDetect.length; i<limit; i++) {
		tExp[tDetect[i]] += 1;
	}

	var repFun = new Array(nt);
	repFun[0] = 0;
	for (var i=1; i<nt; i++) {
		repFun[i] = repFun[i-1] + tExp[i];
	}
	
	// find the time at which repFun is half its max
	var t1, t2;
	var maxRep = repFun[nt-1];
	var thr = 0.4; // should be between 0 & 0.5
	for (var i=1; i<nt; i++) {
		if (repFun[i] >= thr*maxRep && repFun[i-1] <= thr*maxRep) {
			t1 = i;
		}
		if (repFun[i] >= (1-thr)*maxRep && repFun[i-1] <= (1-thr)*maxRep) {
			t2 = i;
		}
	}
	
	return { "diff":results.top_diff, "t1": t1, "t2": t2 };
}

exports.setDebugMode = setDebugMode;
exports.bootstrapComparison = bootstrapComparison;
exports.detectXcorrSteps = detectXcorrSteps;
exports.decode = decode;
