// TEST FIXTURE: the DSH Web half of a stand-in for dsh-mobile-maxxing; does nothing.
window.__ModuleLoader__.load({
  id: 'dsh-mobile-maxxing',
  factory() {
    return { inject: [], apply() {} };
  },
});
