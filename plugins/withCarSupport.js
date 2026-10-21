// Réglages natifs pour Android Auto et CarPlay (appliqués par `npx expo prebuild`).
const fs = require('fs');
const path = require('path');
const { withAppDelegate, withDangerousMod, withEntitlementsPlist, withGradleProperties, withInfoPlist } = require('expo/config-plugins');

const FONT = 'assets/fonts/material_icons.ttf';

// Android : icônes dans res/font, application déclarée comme « navigation » pour Android Auto.
const withAndroid = (config) => {
  config = withDangerousMod(config, ['android', async (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/main/res/font');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(c.modRequest.projectRoot, FONT), path.join(dir, 'material_icons.ttf'));
    // R8 supprimait les classes que Nitro charge par leur nom (plantage « ClassNotFoundException HybridAutoPlayTiming »).
    const rules = path.join(c.modRequest.platformProjectRoot, 'app/proguard-rules.pro');
    const keep = '\n# Android Auto / CarPlay (Nitro charge ces classes par leur nom)\n-keep class com.margelo.nitro.** { *; }\n';
    if (!fs.readFileSync(rules, 'utf8').includes('com.margelo.nitro')) fs.appendFileSync(rules, keep);
    return c;
  }]);
  return withGradleProperties(config, (c) => {
    const set = { ReactNativeAutoPlay_androidAutoAppCategory: 'navigation',
      // Version de test : pas de réduction du code par R8, pour éviter d'autres classes supprimées par erreur.
      'android.enableMinifyInReleaseBuilds': 'false' };
    c.modResults = c.modResults.filter((p) => !(p.key in set));
    for (const [key, value] of Object.entries(set)) c.modResults.push({ type: 'property', key, value });
    return c;
  });
};

const scene = (cls, name, delegate) => [{ UISceneClassName: cls, UISceneConfigurationName: name, UISceneDelegateClassName: delegate }];

// iOS : scènes CarPlay, droit « CarPlay navigation » (à demander à Apple), rendu de la carte sur l'écran de la voiture.
const withIos = (config) => {
  config = withInfoPlist(config, (c) => {
    // On garde la scène du téléphone créée par Expo (SceneDelegate) et on ajoute celles de CarPlay.
    const manifest = c.modResults.UIApplicationSceneManifest ?? {};
    c.modResults.UIApplicationSceneManifest = {
      ...manifest,
      CPSupportsDashboardNavigationScene: true,
      CPSupportsInstrumentClusterNavigationScene: true,
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        ...manifest.UISceneConfigurations,
        CPTemplateApplicationDashboardSceneSessionRoleApplication: scene('CPTemplateApplicationDashboardScene', 'CarPlayDashboard', 'DashboardSceneDelegate'),
        CPTemplateApplicationInstrumentClusterSceneSessionRoleApplication: scene('CPTemplateApplicationInstrumentClusterScene', 'CarPlayCluster', 'ClusterSceneDelegate'),
        CPTemplateApplicationSceneSessionRoleApplication: scene('CPTemplateApplicationScene', 'CarPlayHeadUnit', 'HeadUnitSceneDelegate'),
      },
    };
    return c;
  });
  config = withEntitlementsPlist(config, (c) => {
    c.modResults['com.apple.developer.carplay-maps'] = true;
    return c;
  });
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift' || c.modResults.contents.includes('getRootViewForAutoplay')) return c;
    c.modResults.contents = c.modResults.contents.replace(/(class AppDelegate[^{]*\{\n)/, `$1${HOOK}\n`);
    return c;
  });
};

const HOOK = `  // CarPlay : vue React Native affichée sur l'écran de la voiture (@iternio/react-native-auto-play)
  @objc func getRootViewForAutoplay(moduleName: String, initialProperties: [String: Any]?) -> UIView? {
    var autoPlayRootView: UIView?
    if let factory = reactNativeFactory?.rootViewFactory as? ExpoReactRootViewFactory {
      autoPlayRootView = factory.superView(
        withModuleName: moduleName,
        initialProperties: initialProperties,
        bundleConfiguration: RCTBundleConfiguration(),
        devMenuConfiguration: RCTDevMenuConfiguration(),
      )
    }
    if autoPlayRootView == nil, let factory = reactNativeFactory?.rootViewFactory {
      autoPlayRootView = factory.view(withModuleName: moduleName, initialProperties: initialProperties)
    }
    return autoPlayRootView
  }
`;

module.exports = (config) => withIos(withAndroid(config));
