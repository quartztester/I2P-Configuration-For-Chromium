//go:generate go run -tags generate gen.go

package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"path/filepath"

	. "github.com/eyedeekay/go-ccw"
)

var EXTENSIONS = []string{"i2pchrome.js"}

// EXTENSIONHASHES is a SHA-256 over the extension directory's file paths AND
// contents (see dirContentHash below). The upstream go-ccw integrity check
// (hashdir) only hashes file *names*, so an attacker who swapped the bytes
// of an existing file - e.g. replacing proxy.js with a non-anonymizing
// config while keeping the filename - would pass it. We therefore verify the
// content hash ourselves before ever launching Chromium with
// --load-extension, and refuse to start on mismatch.
var EXTENSIONHASHES = []string{"01e1f021f290f61eca2876a47a6ba5f6310d6f5de57f06b85ae442a7e0e95516"}
var ARGS = []string{
	"--safebrowsing-disable-download-protection",
	"--disable-client-side-phishing-detection",
	"--disable-3d-apis",
	"--disable-accelerated-2d-canvas",
	"--disable-remote-fonts",
	"--disable-sync-preferences",
	"--disable-sync",
	"--disable-speech",
	"--disable-webgl",
	"--disable-reading-from-canvas",
	"--disable-gpu",
	"--disable-auto-reload",
	"--disable-background-networking",
	"--disable-d3d11",
	"--disable-file-system",
}

func writeSubDirectory(fs http.File) {
	log.Println("writing subdirectory")
	name, err := fs.Stat()
	if err != nil {
		log.Fatal(err)
	}
	if embedded, err := fs.Readdir(0); err != nil {
		log.Println("Extension error, embedded extension not read.")
	} else {
		if _, err := os.Stat("i2pchrome.js"); os.IsNotExist(err) {
			os.MkdirAll("i2pchrome.js/"+name.Name(), FS.Mode())
			for _, val := range embedded {
				file, err := FS.Open(val.Name()) //
				if err != nil {
					log.Fatal(err.Error())
				}
				sys := bytes.NewBuffer(nil)
				if _, err := io.Copy(sys, file); err != nil {
					log.Fatal(err.Error())
				}
				ioutil.WriteFile("i2pchrome.js/"+name.Name()+"/"+val.Name(), sys.Bytes(), val.Mode())
			}
		} else {
			log.Println("i2pchrome plugin already found")
		}
	}
}

func writeExtension(val os.FileInfo, system http.FileSystem) {
	if len(val.Name()) > 3 {
		if val.IsDir() {
			os.MkdirAll("i2pchrome.js/"+val.Name(), FS.Mode())
			file, err := FS.Open(val.Name()) //
			if err != nil {
				log.Fatal(err.Error())
			}
			writeSubDirectory(file)
		} else {
			log.Println("Writing file to extension", val.Name())
			file, err := FS.Open(val.Name()) //
			if err != nil {
				log.Fatal(err.Error())
			}
			sys := bytes.NewBuffer(nil)
			if _, err := io.Copy(sys, file); err != nil {
				log.Fatal(err.Error())
			}
			if err := ioutil.WriteFile("i2pchrome.js/"+val.Name(), sys.Bytes(), val.Mode()); err != nil {
				log.Fatal(err.Error())
			}
		}
	} else {
		log.Println("+i2pchrome.js/"+val.Name()+"'", "ignored", "contents", val.Sys())
	}
}

func writeProfile(system http.FileSystem) {
	if embedded, err := FS.Readdir(0); err != nil {
		log.Println("Extension error, embedded extension not read.")
	} else {
		if _, err := os.Stat("i2pchrome.js"); os.IsNotExist(err) {
			os.MkdirAll("i2pchrome.js/icons", FS.Mode())
			os.MkdirAll("i2pchrome.js/options", FS.Mode())
			os.MkdirAll("i2pchrome.js/_locales/en", FS.Mode())
			for _, val := range embedded {
				writeExtension(val, FS)
			}
		} else {
			log.Println("i2pchrome plugin already found")
		}
	}
}

func verifyExtensionContents(dirs, want []string) error {
	for i, dir := range dirs {
		h := sha256.New()
		err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
			if err != nil {
				return nil //nolint:nilerr // skip unreadable entries, same as hashdir
			}
			if info.IsDir() {
				// Chromium generates _metadata/ inside an unpacked
				// extension at runtime; it is derived output, not source.
				if info.Name() == "_metadata" {
					return filepath.SkipDir
				}
				return nil
			}
			io.WriteString(h, p)
			f, ferr := os.Open(p)
			if ferr != nil {
				return ferr
			}
			defer f.Close()
			if _, cerr := io.Copy(h, f); cerr != nil {
				return cerr
			}
			return nil
		})
		if err != nil {
			return err
		}
		got := fmt.Sprintf("%x", h.Sum(nil))
		if got != want[i] {
			return fmt.Errorf("extension content mismatch for %s: want %s got %s", dir, want[i], got)
		}
	}
	return nil
}

func main() {
	writeProfile(FS)
	// verifyExtensionContents is strictly stronger than the path-name-only
	// check inside go-ccw's SecureExtendedChromium, so we gate on it and use
	// the plain launcher (which performs no hash check of its own).
	if err := verifyExtensionContents(EXTENSIONS, EXTENSIONHASHES); err != nil {
		log.Fatal("refusing to launch: ", err)
	}
	CHROMIUM, ERROR = ExtendedChromium("i2pchromium-browser", false, EXTENSIONS, ARGS...)
	if ERROR != nil {
		log.Fatal(ERROR)
	}
	defer CHROMIUM.Close()
	<-CHROMIUM.Done()
}
