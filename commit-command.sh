#!/bin/bash
cd /Users/panbo/Code/PanboProjects/chrome-plugin-one-tab

# Add all changed files
git add .

# Commit with the prepared message
git commit -F commit-message.txt

# Optional: Create a tag for the 1.0 release
git tag -a v1.0 -m "Version 1.0 release"

echo "Changes committed successfully. Use 'git push' to push the changes to the remote repository."
echo "Use 'git push --tags' to push the tags to the remote repository."
