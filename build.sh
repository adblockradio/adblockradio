
# Node.JS part
mkdir ../build
#cp node_modules/zeromq/build/Release/zmq.node ../build/.
cp node_modules/sqlite3/lib/binding/node-v64-linux-x64/node_sqlite3.node ../build/.
pkg demo.js && cp demo-linux ../build/.

# Python part
#cd predictor-ml/
#pyinstaller mlpredict.spec
#cd ../../build
#ln -s ../adblockradio/predictor-ml/dist .

# now run the demo
cd ../build/
./demo-linux
