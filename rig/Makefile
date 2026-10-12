CXX      ?= c++
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra
PYTHON   ?= python3

BINS = stimulus analyze synth_recording
TESTS = tests/test_dsp tests/test_wav

all: $(BINS)

stimulus: stimulus.cpp wav.hpp
	$(CXX) $(CXXFLAGS) -o $@ stimulus.cpp

analyze: analyze.cpp wav.hpp dsp.hpp
	$(CXX) $(CXXFLAGS) -o $@ analyze.cpp

synth_recording: synth_recording.cpp wav.hpp
	$(CXX) $(CXXFLAGS) -o $@ synth_recording.cpp

tests/test_dsp: tests/test_dsp.cpp dsp.hpp
	$(CXX) $(CXXFLAGS) -o $@ tests/test_dsp.cpp

tests/test_wav: tests/test_wav.cpp wav.hpp
	$(CXX) $(CXXFLAGS) -o $@ tests/test_wav.cpp

unit: $(TESTS)
	./tests/test_dsp
	./tests/test_wav

# Numerical recovery checks on synthetic fixtures; no median alignment.
check: all unit
	$(PYTHON) tests/check_recovery.py

.PHONY: all unit check
