.PHONY: all clean install

all: install

clean:
	@echo "Cleaning dependencies..."
	@for dir in src/*/; do \
		if [ -d "$$dir" ]; then \
			echo "Cleaning $$dir"; \
			rm -rf "$$dir/node_modules" "$$dir/package-lock.json"; \
		fi \
	done

install: clean
	@echo "Installing dependencies..."
	@for dir in src/*/; do \
		if [ -f "$$dir/package.json" ]; then \
			echo "Installing dependencies in $$dir"; \
			cd "$$dir" && npm install && cd ../..; \
		fi \
	done
	@echo "Done!"
