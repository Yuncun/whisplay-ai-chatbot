#!/bin/bash
MODE=${1:-claudia}
echo "{\"set_mode\": \"$MODE\"}" | nc -w 1 localhost 12345
echo "Mode set to: $MODE"
