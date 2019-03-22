FROM node:dubnium-stretch

RUN apt-get update \
	&& apt-get install -y git ssh tar gzip ca-certificates build-essential python-dev sqlite3 portaudio19-dev ffmpeg \
	&& apt-get dist-upgrade -y

RUN cd /tmp && wget https://bootstrap.pypa.io/get-pip.py && python get-pip.py

RUN /usr/local/bin/pip install python_speech_features h5py numpy scipy keras tensorflow zerorpc sounddevice psutil