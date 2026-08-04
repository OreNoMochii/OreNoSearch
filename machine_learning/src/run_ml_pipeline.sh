#!/bin/bash
set -e
echo "--- Starting ML Pipeline at $(date) ---"

echo "1. Parsing Profiles..."
python3 parse_profiles_v2.py

echo "2. Extracting Skills..."
python3 extract_skills_v2.py

echo "3. Building Features..."
python3 build_features_v2.py

echo "4. Assembling Final Table..."
python3 assemble_final_v2.py

echo "5. Retraining Models..."
python3 pipeline.py > pipeline_results.txt 2>&1

echo "--- ML Pipeline Complete at $(date) ---"
