#!/bin/bash
#* Usage:
# * 1. Set Splunk Environment Variables:
# * export SPLUNK_HOST="your-splunk-host.com"
# * export SPLUNK_PORT="8089"
# * export SPLUNK_USER="your-username"
# * export SPLUNK_PASSWORD="your-password"

# SignalFx API Token (you can also set this as an environment variable)
#
# Please set SPLUNK_HOST (e.g., "allwyn.signalfx.com")
#and SPLUNK_APM_TOKEN (your "x-sf-token").



export SPLUNK_APM_TOKEN="<redacted>"
export SPLUNK_HOST="api.eu2.signalfx.com"
export SPLUNK_PORT="443"
export SPLUNK_UI_HOST="<redacted>"
export IGNORE_SSL="true"
export DEBUG_TRACE_DIR="./splunk_traces"

#Adapt the following example to your needs
node api-tracer.js v1.75_20251201.zip "api\\.dfe-01\\.test\\.<redacted>\\.com" 2025011*.har 20251117*.har

if [[ $? -eq 0 ]] ; then
start report.html

fi
