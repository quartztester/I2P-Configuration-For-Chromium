
VERSION=2.1.2
# GitHub owner for `make release` (gothub -u). Built-in $(USER) is the login
# name, so use a dedicated variable defaulting to upstream.
GHUSER ?= eyedeekay

all: gen
	GOOS=windows go build -o i2pchromium.exe
	GOOS=darwin go build -o i2pchromium-darwin
	GOOS=linux go build -o i2pchromium

gen:
	go run -tags generate gen.go

release:
	gothub release -p -u $(GHUSER) -r "I2P-Configuration-for-Chromium" -t $(VERSION) -n "Launchers" -d "A self-configuring launcher for I2P Browsing with Chromium"; true
	gothub upload -R -u $(GHUSER) -r "I2P-Configuration-for-Chromium" -t $(VERSION) -n "i2pchromium.exe" -f "i2pchromium.exe"
	gothub upload -R -u $(GHUSER) -r "I2P-Configuration-for-Chromium" -t $(VERSION) -n "i2pchromium-darwin" -f "i2pchromium-darwin"
	gothub upload -R -u $(GHUSER) -r "I2P-Configuration-for-Chromium" -t $(VERSION) -n "i2pchromium" -f "i2pchromium"

zip:
	cd i2pchrome.js && make zip

test:
	bash test/run-all.sh

test-live:
	node test/live-i2p-e2e.test.js

test-interactive:
	chromium --user-data-dir=testchromium --load-extension=./i2pchrome.js
