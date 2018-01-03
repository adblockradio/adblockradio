var log = require("loglevel");
log.setLevel("debug");
var png = require("node-png").PNG;
var fs = require("fs");


var colormap = function(x, buffer, index, color) {
	var mask = [1,1,1];
	if (color == 'r') {
		mask = [0,1,1];
	} else if (color == 'b') {
		mask = [1,1,0];
	} else if (color == 'grey') {
		mask = [0.5,0.5,0.5];
	}
	var r = 255*Math.sqrt(Math.min(Math.max(x,0),1));
	buffer[index] = Math.round(255-r*mask[0]);
	buffer[index+1] = Math.round(255-r*mask[1]);
	buffer[index+2] = Math.round(255-r*mask[2]);
	buffer[index+3] = 255; // alpha channel
}

var minmax = function(a,nDim) {
	var norm = [0, 0];
	for (var x = 0; x < a.length; x++) {
		if (nDim == 1) {
			norm[0] = Math.min(a[x], norm[0]);
			norm[1] = Math.max(a[x], norm[1]);
		} else if (nDim == 2) {
			for (var y = 0; y < a[0].length; y++) {
				norm[0] = Math.min(a[x][y], norm[0]);
				norm[1] = Math.max(a[x][y], norm[1]);
			}
		}
	}
	return norm;
}

var drawMarker = function(img, x, y, radius) {
	//console.log("draw marker x=" + x + " y=" + y);
	colormap(1, img.data, ((img.width * (img.height-1-y) + x) << 2), 'b');
	if (radius > 1) {
		drawMarker(img, x+1, y, radius-1);
		drawMarker(img, x, y+1, radius-1);
		drawMarker(img, x-1, y, radius-1);
		drawMarker(img, x, y-1, radius-1);
	}
	return;
}

var drawLine = function(img, x1, x2, y1, y2) {
	log.debug("draw line x1=" + x1 + " y1=" + y1 + " x2=" + x2 + " y2=" + y2);
	var len = Math.round(Math.sqrt(Math.pow(y2-y1,2)+Math.pow(x2-x1,2)));
	for (var i=0; i<=len; i++) {
		var x = x1+Math.round((x2-x1)*i/len);
		var y = y1+Math.round((y2-y1)*i/len);
		colormap(1, img.data, ((img.width * (img.height-1-y) + x) << 2), 'grey');
	}

}

var newPng = function(pngWidth, pngHeight) {
	var img = new png({width:pngWidth,height:pngHeight});
	img.data = new Buffer(img.width * img.height * 4);
	img.data.fill(255); // solid white background
	img.width = pngWidth;
	img.height = pngHeight;
	return img;
}


var savePng = function(img, fileName) {
	img.pack().pipe(fs.createWriteStream(fileName));
}

exports.colormap = colormap;
exports.minmax = minmax;
exports.drawMarker = drawMarker;
exports.drawLine = drawLine;
exports.newPng = newPng;
exports.savePng = savePng;
