/*
* This program and the accompanying materials are made available under the terms of the *
* Eclipse Public License v2.0 which accompanies this distribution, and is available at *
* https://www.eclipse.org/legal/epl-v20.html                                      *
*                                                                                 *
* SPDX-License-Identifier: EPL-2.0                                                *
*                                                                                 *
* Copyright Contributors to the Zowe Project.                                     *
*                                                                                 *
*/

/**
 * Main class of the Imperative framework, returned when you
 * require("imperative") e.g. const imperative =  require("imperative");
 */
import { Logger } from "../../logger";
import { IImperativeConfig } from "./doc/IImperativeConfig";
import { Arguments } from "yargs";
import { ConfigurationLoader } from "./ConfigurationLoader";
import { ConfigurationValidator } from "./ConfigurationValidator";
import { isNullOrUndefined } from "util";
import { ImperativeApi } from "./api/ImperativeApi";
import { IImperativeApi } from "./api/doc/IImperativeApi";
import { Constants } from "../../constants";
import { TextUtils } from "../../utilities";
import { ImperativeReject } from "../../interfaces";
import { LoggingConfigurer } from "./LoggingConfigurer";
import { ImperativeError } from "../../error";
import { PluginManagementFacility } from "./plugins/PluginManagementFacility";
import {
    CliProfileManager,
    CommandYargs,
    ICommandDefinition,
    ICommandProfileTypeConfiguration,
    ICommandResponseParms,
    IHelpGenerator,
    IHelpGeneratorFactory,
    IHelpGeneratorParms,
    IYargsResponse,
    YargsConfigurer,
    YargsDefiner
} from "../../cmd";
import { ProfileUtils } from "../../profiles";
import { ImperativeHelpGeneratorFactory } from "./help/ImperativeHelpGeneratorFactory";
import { OverridesLoader } from "./OverridesLoader";
import { ImperativeProfileManagerFactory } from "./profiles/ImperativeProfileManagerFactory";
import { ImperativeConfig } from "./ImperativeConfig";
import { EnvironmentalVariableSettings } from "./env/EnvironmentalVariableSettings";

export class Imperative {

    /**
     *  Retrieve the root command name.
     *  @example
     *  For example, in "banana a b --c", banana is the root command name.
     *  @returns {string} - root command name
     */
    public static get rootCommandName(): string {
        return this.mRootCommandName;
    }

    /**
     * Get the complete full command tree
     * @returns {ICommandDefinition}
     */
    public static get fullCommandTree(): ICommandDefinition {
        return this.mFullCommandTree;
    }

    /**
     * Initialize the configuration for your CLI.
     * Wipes out any existing config that has already been set.
     *
     * @param {IImperativeConfig} [config] Configuration for Imperative provided by your application.
     *                                     If this parameter is not set, we will look in the closest
     *                                     package.json up the directory tree from the main entry
     *                                     point of your cli.
     *
     *                                     package.imperative.configurationModule should point to the
     *                                     compiled module that exports the configuration.
     *
     * @returns {Promise<void>} A promise indicating that we are done here.
     */
    public static init(config?: IImperativeConfig): Promise<void> {
        return new Promise<void>(async (initializationComplete: () => void, initializationFailed: ImperativeReject) => {
            try {
                /**
                 * Identify caller's location on the system
                 */
                ImperativeConfig.instance.callerLocation = process.mainModule.filename;

                /**
                 * Load callers configuration, validate, and save
                 */
                config = ConfigurationLoader.load(config, ImperativeConfig.instance.callerPackageJson,
                    ImperativeConfig.instance.getCallerFile
                );
                ConfigurationValidator.validate(config);
                ImperativeConfig.instance.loadedConfig = config;

                /**
                 * Once we have a complete representation of the config object, we should be able to
                 * use that and populate all required categories and expose them on our API object
                 * so that an app using imperative can write to the imperative log, its own log, or
                 * even a plug-in log.
                 *
                 * Any other initialization added to this routine should occur after logging has been initialized.
                 */
                this.initLogging();

                /**
                 * Now we should apply any overrides to default Imperative functionality. This is where CLI
                 * developers are able to really start customizing Imperative and how it operates internally.
                 */
                await OverridesLoader.load(ImperativeConfig.instance.loadedConfig);

                /**
                 * Get the command name from the package bin.
                 * If no command name exists, we will instead use the file name invoked
                 * and log a debug warning.
                 */
                if (!isNullOrUndefined(ImperativeConfig.instance.findPackageBinName())) {
                    this.mRootCommandName = ImperativeConfig.instance.findPackageBinName();
                }
                else {
                    this.mRootCommandName = ImperativeConfig.instance.callerLocation;
                    this.mLog.debug("WARNING: No \"bin\" configuration was found in your package.json," +
                        " or your package.json could not be found. " +
                        "Defaulting command name to filepath instead.");
                }

                // If plugins are allowed, enable core plugins commands
                if (config.allowPlugins) {
                    PluginManagementFacility.instance.init();
                }

                /**
                 * Build API object
                 */
                this.mApi = this.constructApiObject();

                /**
                 * Build the help generator factory - requires the root command name and the loaded configuration document
                 */
                this.mHelpGeneratorFactory = new ImperativeHelpGeneratorFactory(this.rootCommandName, ImperativeConfig.instance.loadedConfig);

                // resolve command module globs, forming the root of the CLI command tree
                this.log.debug("The following config was found: " + JSON.stringify(config, null, 2));
                const resolvedHostCliCmdTree: ICommandDefinition = ImperativeConfig.instance.resolvedCmdTree;

                // If plugins are allowed, add plugins' commands and profiles to the CLI command tree
                if (config.allowPlugins) {
                  PluginManagementFacility.instance.addPluginsToHostCli(resolvedHostCliCmdTree);
                }

                // final preparation of the command tree
                const preparedHostCliCmdTree = ImperativeConfig.instance.getPreparedCmdTree(resolvedHostCliCmdTree);

                /**
                 * Initialize the profile environment
                 */
                this.initProfiles(config);

                /**
                 * Define all known commands
                 */
                this.defineCommands(preparedHostCliCmdTree);

                /**
                 * Notify caller initialization is complete
                 */
                initializationComplete();
            } catch (error) {
                initializationFailed(
                    error instanceof ImperativeError ?
                        error :
                        new ImperativeError({
                            msg: "UNEXPECTED ERROR ENCOUNTERED",
                            causeErrors: error
                        })
                );
            }
        });
    }

    /**
     * Returns the default console object to be used for messaging for
     * imperative fails to initialize or to be used before logging
     * is initialized.
     * @return {Logger}: an instance of the default console object
     */
    public static get console(): Logger {
        return this.constructConsoleApi();
    }

    /**
     * Parse command line arguments and issue the user's specified command
     * @returns {Imperative} this, for chaining syntax
     */
    public static parse(): Imperative {
        Imperative.yargs.argv; // tslint:disable-line
        return this;
    }

    /**
     *
     * @param {string} type the profile type to search for configuration for
     * @returns {IImperativeProfileConfig | undefined}  The profile configuration if found, otherwise, undefined.
     */
    public static getProfileConfiguration(type: string): ICommandProfileTypeConfiguration | undefined {
        const profileConfigs = ImperativeConfig.instance.loadedConfig.profiles;
        if (isNullOrUndefined(profileConfigs) || profileConfigs.length === 0) {
            return undefined;
        }
        let foundConfig: ICommandProfileTypeConfiguration;
        for (const profile of profileConfigs) {
            if (profile.type === type) {
                foundConfig = profile;
            }
        }
        return foundConfig;
    }

    /**
     * Get the configured help generator for your CLI. If you have not specified a custom generator,
     * the DefaultHelpGenerator will be used.
     * You probably won't need to call this from your CLI, but it is used internally.
     * @returns {IHelpGenerator} - The help generator for the command
     * @param {IHelpGeneratorParms} parms - parameters to the help generator including command definition
     */
    public static getHelpGenerator(parms: IHelpGeneratorParms): IHelpGenerator {
        return this.mHelpGeneratorFactory.getHelpGenerator(parms);
    }

    /**
     * Returns the imperative API object containing various framework API methods for usage in your CLI implemenation.
     * @return {ImperativeApi}: The api object.
     */
    public static get api(): ImperativeApi {
        if (isNullOrUndefined(this.mApi)) {
            throw new ImperativeError(
                {
                    msg: "Imperative API object does not exist.  The Imperative.init() promise " +
                    "must be fullfilled before the API object can be accessed.  For issuing messages " +
                    "without the API object, use Imperative.console.",
                },
                {
                    suppressReport: true, // node-report is unnecessary here
                    logger: Imperative.console,
                }
            );
        }
        return this.mApi;
    }

    /**
     * Highlight text with your configured (or default) primary color
     * @param {string} text - the text to highlight
     * @returns {string} - the highlighted text
     */
    public static highlightWithPrimaryColor(text: string): string {
        return TextUtils.chalk[ImperativeConfig.instance.loadedConfig.primaryTextColor](text);
    }

    /**
     * Get the configured environmental variable prefix for the user's CLI
     * @returns {string} - the configured or default prefix for environmental variables for use in the environmental variable service
     */
    public static get envVariablePrefix(): string {
        return ImperativeConfig.instance.loadedConfig.envVariablePrefix == null ? ImperativeConfig.instance.loadedConfig.name :
            ImperativeConfig.instance.loadedConfig.envVariablePrefix;
    }

    /**
     * Highlight text with your configured (or default) secondary color
     * @param {string} text - the text to highlight
     * @returns {string} - the highlighted text
     */
    public static highlightWithSecondaryColor(text: string): string {
        return TextUtils.chalk[ImperativeConfig.instance.loadedConfig.secondaryTextColor](text);
    }

    private static yargs = require("yargs");
    private static mApi: ImperativeApi;
    private static mLog: Logger;
    private static mConsoleLog: Logger;
    private static mFullCommandTree: ICommandDefinition;
    private static mRootCommandName: string;
    private static mHelpGeneratorFactory: IHelpGeneratorFactory;

    /**
     * Get log instance
     */
    private static get log(): Logger {
        return this.mLog;
    }

    /**
     * Init log object such that subsequent calls to the Logger.getImperativeLogger() (or
     * other similar calls), will contain all necessary categories for logging.
     *
     * TODO(Kelosky): handle level setting via global config (trace enabling and such)
     */
    private static initLogging() {

        /**
         * Build logging config from imperative config
         */
        const loggingConfig = LoggingConfigurer.configureLogger(ImperativeConfig.instance.cliHome, ImperativeConfig.instance.loadedConfig);

        /**
         * Setup log4js
         */
        Logger.initLogger(loggingConfig);

        /**
         * Save reference to our instance
         */
        this.mLog = Logger.getImperativeLogger();

        /**
         * Set log levels from environmental variable settings
         */
        const envSettings = EnvironmentalVariableSettings.read(this.envVariablePrefix);
        if (envSettings.imperativeLogLevel.value != null) {
            // set the imperative log level based on the user's environmental variable, if any
            this.mLog.level = envSettings.imperativeLogLevel.value;
            this.mLog.info("Set imperative log level to %s from environmental variable setting '%s'",
                envSettings.imperativeLogLevel.value, envSettings.imperativeLogLevel.key);
        } else {
            this.mLog.info("Environmental setting for imperative log level ('%s') was blank.", envSettings.imperativeLogLevel.key);
        }

        if (envSettings.appLogLevel.value != null) {
            // set the app log level based on the user's environmental variable, if any
            Logger.getAppLogger().level = envSettings.appLogLevel.value;
            this.mLog.info("Set app log level to %s from environmental variable setting '%s'",
                envSettings.appLogLevel.value, envSettings.appLogLevel.key);
        } else {
            this.mLog.info("Environmental setting for app log level ('%s') was blank.", envSettings.appLogLevel.key);
        }
    }

    /**
     * Initialize the profiles directory with types and meta files. This can be called every startup of the CLI
     * without issue, but if the meta files or configuration changes, we'll have to re-initialize.
     * TODO: Determine the re-initialize strategy.
     * @private
     * @static
     * @param {IImperativeConfig} config - The configuration document passed to init.
     * @memberof Imperative
     */
    private static initProfiles(config: IImperativeConfig) {
        if (!isNullOrUndefined(config.profiles) && config.profiles.length > 0) {
            CliProfileManager.initialize({
                configuration: config.profiles,
                profileRootDirectory: ProfileUtils.constructProfilesRootDirectory(ImperativeConfig.instance.cliHome),
                reinitialize: false
            });
        }
    }

    /**
     * Define to yargs for main CLI and plugins
     *
     * @param {ICommandDefinition} preparedHostCliCmdTree - The Root of the imperative host CLI
     *        which has already prepared by ImperativeConfig.getPreparedCmdTree.
     */
    private static defineCommands(preparedHostCliCmdTree: ICommandDefinition) {
        this.log.debug("The following command tree was defined: " + JSON.stringify(preparedHostCliCmdTree, null, 2));
        const commandResponseParms: ICommandResponseParms = {
            primaryTextColor: ImperativeConfig.instance.loadedConfig.primaryTextColor,
            progressBarSpinner: ImperativeConfig.instance.loadedConfig.progressBarSpinner
        };

        // Configure Yargs to meet the CLI's needs
        new YargsConfigurer(
            preparedHostCliCmdTree,
            Imperative.yargs,
            commandResponseParms,
            new ImperativeProfileManagerFactory(this.api),
            this.mHelpGeneratorFactory,
            ImperativeConfig.instance.loadedConfig.experimentalCommandDescription,
            this.rootCommandName).configure();

        // Define the commands to yargs
        CommandYargs.defineOptionsToYargs(Imperative.yargs, preparedHostCliCmdTree.options);
        const definer = new YargsDefiner(
            Imperative.yargs,
            ImperativeConfig.instance.loadedConfig.primaryTextColor,
            Imperative.rootCommandName,
            new ImperativeProfileManagerFactory(this.api),
            this.mHelpGeneratorFactory,
            ImperativeConfig.instance.loadedConfig.experimentalCommandDescription
        );

        for (const child of preparedHostCliCmdTree.children) {
            definer.define(child,
                (args: Arguments, response: IYargsResponse) => {
                    if (!response.success) {
                        process.exitCode = Constants.ERROR_EXIT_CODE;
                    }
                }, commandResponseParms
            );
        }
        Imperative.mFullCommandTree = preparedHostCliCmdTree;
    }

    /**
     * Construct the API object for return to caller of init()
     * @return {ImperativeApi}: The API object
     */
    private static constructApiObject(): ImperativeApi {
        const apiParms: IImperativeApi = {
            imperativeLogger: this.constructImperativeLoggerApi(),
            appLogger: this.constructAppLoggerApi()
        };
        let api = new ImperativeApi(
            apiParms,
            ImperativeConfig.instance.loadedConfig,
            ImperativeConfig.instance.cliHome
        );

        /**
         * Add dynamic API methods to API object
         */
        api = this.constructDynamicLoggersApi(api);

        return api;
    }


    /**
     * Build the Logger API object for the app using the framework
     * @return {Logger}: returns the app Logger API object
     */
    private static constructAppLoggerApi(): Logger {
        return Logger.getAppLogger();
    }

    /**
     * Build the imperative API object for the app using the framework
     * @return {Logger}: returns the imperative Logger API object
     */
    private static constructImperativeLoggerApi(): Logger {
        return Logger.getImperativeLogger();
    }

    /**
     * Build the default console API object for the framework
     * @return {Logger}: returns the default console Logger API object
     */
    private static constructConsoleApi(): Logger {
        if (isNullOrUndefined(Imperative.mConsoleLog)) {
            Imperative.mConsoleLog = Logger.getConsoleLogger();
            return Imperative.mConsoleLog;
        } else {
            return Imperative.mConsoleLog;
        }
    }

    private static constructDynamicLoggersApi(api: any) {
        const loadedConfig: IImperativeConfig = ImperativeConfig.instance.loadedConfig;
        if (loadedConfig.logging.additionalLogging != null &&
            loadedConfig.logging.additionalLogging.length > 0) {
            for (const logConfig of loadedConfig.logging.additionalLogging) {
                api.addAdditionalLogger(logConfig.apiName, Logger.getLoggerCategory(logConfig.apiName));
            }
        }
        return api;
    }

}
