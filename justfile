PATCHDIR := "patches"

assert-clean:
  sh -lc 'test -z "$(git status --porcelain)" || { echo "Working tree not clean:"; git status --porcelain; exit 1; }'

patch-head: assert-clean
  mkdir -p {{PATCHDIR}}
  git format-patch -1 HEAD --output-directory {{PATCHDIR}}
  @echo "Wrote patch for HEAD into {{PATCHDIR}}/"
