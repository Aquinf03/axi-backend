#!/bin/bash

DIR_GEN=()
FILE_GEN=()

UI_DIR="src/ui"
UI_BAK="src/ui.bak"

GENERATED=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

revert_ui() {
	if [ -L "$UI_DIR" ]; then
		printf "${BOLD}${BRIGHT_GREEN}[ RM ] Removing \`$UI_DIR\` symlink${RESET} "
		rm "$UI_DIR"
		echo -e "${BOLD}${BRIGHT_GREEN}[ OK ]${RESET}"
	elif [ -e "$UI_DIR" ]; then
		printf "${BOLD}${BRIGHT_GREEN}[ RM ] Removing \`$UI_DIR\`${RESET} "
		rm -rf "$UI_DIR"
		echo -e "${BOLD}${BRIGHT_GREEN}[ OK ]${RESET}"
	fi

	if [ ! -e "$UI_BAK" ]; then
		echo -e "${BOLD}${CYAN}[ NOTE ] No \`$UI_BAK\` to restore${RESET}"
		bash "$SCRIPT_DIR/scripts/ui-git-state.sh" unskip || true
		return 1
	fi

	printf "${BOLD}${BRIGHT_GREEN}[ MV ] Restoring \`$UI_BAK\` → \`$UI_DIR\`${RESET} "
	mv "$UI_BAK" "$UI_DIR"
	echo -e "${BOLD}${BRIGHT_GREEN}[ OK ]${RESET}"

	# Allow committing the restored real directory again.
	bash "$SCRIPT_DIR/scripts/ui-git-state.sh" unskip || true
	return 0
}

if [ "$1" == "ungen" ]; then
	echo -e "${BOLD}[ * ] Removing generated files / restoring UI backup"

	if [ "${2,,}" == "yes" ] || [ "${2,,}" == "y" ]; then
		answer="Y"
	else
		echo -e "${RED}[ WARN ] Are you sure that you want to continue? This will remove all existing data [ Y / N ]${RESET}"

		read answer
	fi

	if [ "${answer,,}" == "yes" ] || [ "${answer,,}" == "y" ] ; then
		for dir in "${DIR_GEN[@]}"; do
			if [ ! -d "$dir" ]; then
				continue
			fi

			printf "${BOLD}${BRIGHT_GREEN}[ RMDIR ] Removing \`$dir\` directory${RESET} " ; rm -r $dir ; echo -e "${BOLD}${BRIGHT_GREEN}[ OK ]${RESET}"
		done

		for file in "${FILE_GEN[@]}"; do
			if [ ! -f "$file" ]; then
				continue
			fi

			printf "${BOLD}${BRIGHT_GREEN}[ RM ] Removing \`$file\` file${RESET} " ; rm $file ; echo -e "${BOLD}${BRIGHT_GREEN}[ OK ]${RESET}"
		done

		revert_ui || true

		echo -e "[ DONE ]${RESET}"

	else
		echo -e "${RESET}Abort."
	fi

	echo -e "${BOLD}${CYAN}[ NOTE ] Execute this file without the \`ungen\` flag to generate all files"
	exit
fi

bash "$SCRIPT_DIR/scripts/ui-git-state.sh" install-hooks || true

for dir in "${DIR_GEN[@]}"; do
	if [ -d "$dir" ]; then
		continue
	fi

	printf "${BOLD}${BRIGHT_GREEN}[ MKDIR ] Generating \`$dir\` directory${RESET} " ; mkdir -p $dir ; echo -e "${BOLD}${BRIGHT_GREEN}[ OK ]${RESET}"

	GENERATED=1
done

for file in "${FILE_GEN[@]}"; do
	if [ ! -f "$file" ]; then
		printf "${BOLD}${BRIGHT_GREEN}[ TOUCH ] Generating \`$file\` file${RESET} " ; touch $file ; echo -e "${BOLD}${BRIGHT_GREEN}[ OK ]${RESET}"
		GENERATED=1
	fi
done

if [ $GENERATED -eq 1 ]; then
	echo -e "[ DONE ]"

elif [ $GENERATED -eq 0 ]; then
	echo -e "[ DONE ] No files to generate"
fi
