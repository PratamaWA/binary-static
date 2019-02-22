import debounce                          from 'lodash.debounce';
import {
    action,
    observable,
    reaction,
    runInAction }                        from 'mobx';
import BinarySocket                      from '_common/base/socket_base';
import { localize }                      from '_common/localize';
import {
    cloneObject,
    isEmptyObject,
    getPropertyValue }                   from '_common/utility';
import {
    getMinPayout,
    isCryptocurrency }                   from '_common/base/currency_base';
import { WS }                            from 'Services';
import GTM                               from 'Utils/gtm';
import URLHelper                         from 'Utils/URL/url-helper';
import { processPurchase }               from './Actions/purchase';
import * as Symbol                       from './Actions/symbol';
import {
    allowed_query_string_variables,
    getNonProposalQueryStringVariables } from './Constants/query-string';
import getValidationRules                from './Constants/validation-rules';
import { setChartBarrier }               from './Helpers/chart';
import ContractType                      from './Helpers/contract-type';
import { convertDurationLimit }          from './Helpers/duration';
import { processTradeParams }            from './Helpers/process';
import {
    createProposalRequests,
    getProposalInfo,
    getProposalParametersName }          from './Helpers/proposal';
import { pickDefaultSymbol }             from './Helpers/symbol';
import BaseStore                         from '../../base-store';

const store_name = 'trade_store';

export default class TradeStore extends BaseStore {
    // Control values
    @observable is_trade_component_mounted = false;
    @observable is_purchase_enabled        = false;
    @observable is_trade_enabled           = false;
    @observable is_allow_equal             = false;
    @observable is_equal_checked           = 0;

    // Underlying
    @observable symbol;

    // Contract Type
    @observable contract_expiry_type = '';
    @observable contract_start_type  = '';
    @observable contract_type        = '';
    @observable contract_types_list  = {};
    @observable form_components      = [];
    @observable trade_types          = {};

    // Amount
    @observable amount          = 10;
    @observable basis           = '';
    @observable basis_list      = [];

    // Duration
    @observable duration            = 5;
    @observable duration_unit       = '';
    @observable duration_units_list = [];
    @observable duration_min_max    = {};
    @observable expiry_date         = '';
    @observable expiry_time         = '';
    @observable expiry_type         = 'duration';

    // Barrier
    @observable barrier_1     = '';
    @observable barrier_2     = '';
    @observable barrier_count = 0;

    // Start Time
    @observable start_date       = Number(0); // Number(0) refers to 'now'
    @observable start_dates_list = [];
    @observable start_time       = null;
    @observable sessions         = [];

    @observable market_open_times = [];
    // End Date Time
    /**
     * An array that contains market closing time.
     *
     * e.g. ["04:00:00", "08:00:00"]
     *
     */
    @observable market_close_times = [];

    // Last Digit
    @observable last_digit = 5;

    // Purchase
    @observable proposal_info        = {};
    @observable purchase_info        = {};

    // Chart
    chart_id = 1;

    debouncedProposal = debounce(this.requestProposal, 500);
    proposal_requests = {};
    @action.bound
    init = async () => {
        // To be sure that the website_status response has been received before processing trading page.
        await BinarySocket.wait('website_status');
    };

    constructor({ root_store }) {
        URLHelper.pruneQueryString(allowed_query_string_variables);

        super({
            root_store,
            store_name,
            session_storage_properties: allowed_query_string_variables,
            validation_rules          : getValidationRules(),
        });

        Object.defineProperty(
            this,
            'is_query_string_applied',
            {
                enumerable: false,
                value     : false,
                writable  : true,
            },
        );
        // Adds intercept to change min_max value of duration validation
        reaction(
            () => [this.contract_expiry_type, this.duration_min_max, this.duration_unit, this.expiry_type],
            () => {
                this.changeDurationValidationRules();
            },
        );
        reaction(
            () => [
                this.symbol,
                this.contract_type,
                this.duration_unit,
                this.expiry_type,
                this.duration_units_list,
                this.contract_types_list,
            ],
            () => {
                this.changeAllowEquals();
            },
            { delay: 500 }
        );
    }

    @action.bound
    refresh() {
        this.symbol = null;
        WS.forgetAll('proposal');
    }

    @action.bound
    async prepareTradeStore() {
        let query_string_values = this.updateQueryString();
        this.smart_chart        = this.root_store.modules.smart_chart;
        const active_symbols    = await WS.activeSymbols();
        if (!active_symbols.active_symbols || active_symbols.active_symbols.length === 0) {
            this.root_store.common.showError(localize('Trading is unavailable at this time.'));
        }

        // Checks for finding out that the current account has access to the defined symbol in quersy string or not.
        const is_invalid_symbol = !!query_string_values.symbol &&
            !active_symbols.active_symbols.find(s => s.symbol === query_string_values.symbol);

        // Changes the symbol in query string to default symbol since the account doesn't have access to the defined symbol.
        if (is_invalid_symbol) {
            this.root_store.ui.addToastMessage({
                message: localize('Certain trade parameters have been changed due to your account settings.'),
                type   : 'info',
            });
            URLHelper.setQueryParam({ 'symbol': pickDefaultSymbol(active_symbols.active_symbols) });
            query_string_values = this.updateQueryString();
        }

        if (!this.symbol) {
            await this.processNewValuesAsync({
                symbol: pickDefaultSymbol(active_symbols.active_symbols),
                ...query_string_values,
            });
        }

        if (this.symbol) {
            ContractType.buildContractTypesConfig(query_string_values.symbol || this.symbol).then(action(async () => {
                await this.processNewValuesAsync({
                    ...ContractType.getContractValues(this),
                    ...ContractType.getContractCategories(),
                    ...query_string_values,
                });
            }));
        }
    }

    @action.bound
    onChangeMultiple(values) {
        Object.keys(values).forEach((name) => {
            if (!(name in this)) {
                throw new Error(`Invalid Argument: ${name}`);
            }
        });

        this.processNewValuesAsync({ ...values }, true);
    }

    @action.bound
    onChange(e) {
        const { name, checked } = e.target;
        let { value } = e.target;

        if (name === 'currency') {
            this.root_store.client.selectCurrency(value);
        } else if (value === 'is_equal') {
            if (/^(rise_fall|rise_fall_equal)$/.test(this.contract_type)) {
                if (checked) {
                    this.is_equal_checked = 1;
                    value = 'rise_fall_equal';
                } else {
                    this.is_equal_checked = 0;
                    value = 'rise_fall';
                }
            }
        } else if (name  === 'expiry_date') {
            this.expiry_time = null;
        } else if (!(name in this)) {
            throw new Error(`Invalid Argument: ${name}`);
        }

        this.processNewValuesAsync({ [name]: value }, true);
    }

    @action.bound
    onHoverPurchase(is_over, contract_type) {
        this.smart_chart.updateBarrierShade(is_over, contract_type);
    }

    @action.bound
    onPurchase(proposal_id, price, type) {
        if (proposal_id) {
            processPurchase(proposal_id, price).then(action((response) => {
                if (this.proposal_info[type].id !== proposal_id) {
                    throw new Error('Proposal ID does not match.');
                }
                if (response.buy) {
                    const contract_data = {
                        ...this.proposal_requests[type],
                        ...this.proposal_info[type],
                        buy_price: response.buy.buy_price,
                    };
                    GTM.pushPurchaseData(contract_data, this.root_store);
                }
                WS.forgetAll('proposal');
                this.purchase_info = response;
            }));
        }
    }

    @action.bound
    onClickNewTrade(e) {
        e.preventDefault();
        WS.forgetAll('proposal').then(this.requestProposal());
    }

    /**
     * Updates the store with new values
     * @param  {Object} new_state - new values to update the store with
     * @return {Object} returns the object having only those values that are updated
     */
    @action.bound
    updateStore(new_state) {
        Object.keys(cloneObject(new_state)).forEach((key) => {
            if (key === 'root_store' || ['validation_rules', 'validation_errors', 'currency', 'smart_chart'].indexOf(key) > -1) return;
            if (JSON.stringify(this[key]) === JSON.stringify(new_state[key])) {
                delete new_state[key];
            } else {
                if (key === 'symbol') {
                    this.is_purchase_enabled = false;
                    this.is_trade_enabled    = false;
                }

                if (new_state.start_date && typeof new_state.start_date === 'string') {
                    new_state.start_date = parseInt(new_state.start_date);
                }

                // Add changes to queryString of the url
                if (
                    allowed_query_string_variables.indexOf(key) !== -1 &&
                    this.is_trade_component_mounted
                ) {
                    URLHelper.setQueryParam({ [key]: new_state[key] });
                }

                this[key] = new_state[key];

                // validation is done in mobx intercept (base_store.js)
                // when barrier_1 is set, it is compared with store.barrier_2 (which is not updated yet)
                if (key === 'barrier_2' && new_state.barrier_1) {
                    this.barrier_1 = new_state.barrier_1; // set it again, after barrier_2 is updated in store
                }
            }
        });

        return new_state;
    }

    async processNewValuesAsync(obj_new_values = {}, is_changed_by_user = false) {
        // Sets the default value to Amount when Currency has changed from Fiat to Crypto and vice versa.
        // The source of default values is the website_status response.
        WS.forgetAll('proposal');

        if (is_changed_by_user &&
            /\bcurrency\b/.test(Object.keys(obj_new_values)) &&
            isCryptocurrency(obj_new_values.currency) !== isCryptocurrency(this.currency)
        ) {
            obj_new_values.amount = obj_new_values.amount || getMinPayout(obj_new_values.currency);
        }

        const new_state = this.updateStore(cloneObject(obj_new_values));

        if (is_changed_by_user || /\b(symbol|contract_types_list)\b/.test(Object.keys(new_state))) {
            if ('symbol' in new_state) {
                await Symbol.onChangeSymbolAsync(new_state.symbol);
            }

            this.updateStore({ // disable purchase button(s), clear contract info
                is_purchase_enabled: false,
                proposal_info      : {},
            });

            if (!this.smart_chart.is_contract_mode) {
                const is_barrier_changed = 'barrier_1' in new_state || 'barrier_2' in new_state;
                if (is_barrier_changed) {
                    this.smart_chart.updateBarriers(this.barrier_1, this.barrier_2);
                } else {
                    this.smart_chart.removeBarriers();
                }
            }

            const snapshot            = await processTradeParams(this, new_state);
            const query_string_values = this.updateQueryString();
            snapshot.is_trade_enabled = true;

            this.updateStore({
                ...snapshot,
                ...(this.is_query_string_applied ? {} : query_string_values), // Applies the query string values again to set barriers.
            });

            this.is_query_string_applied = true;

            if (/\bcontract_type\b/.test(Object.keys(new_state))) {
                this.validateAllProperties();
            }

            this.debouncedProposal();
        }
    }

    @action.bound
    requestProposal() {
        const requests = createProposalRequests(this);

        if (Object.values(this.validation_errors).some(e => e.length)) {
            this.proposal_info = {};
            this.purchase_info = {};
            WS.forgetAll('proposal');
            return;
        }

        if (!isEmptyObject(requests)) {
            const proper_proposal_params_for_query_string = getProposalParametersName(requests);

            URLHelper.pruneQueryString(
                [
                    ...proper_proposal_params_for_query_string,
                    ...getNonProposalQueryStringVariables(this),
                ],
            );

            this.proposal_requests = requests;
            this.proposal_info     = {};
            this.purchase_info     = {};

            Object.keys(this.proposal_requests).forEach((type) => {
                WS.subscribeProposal(this.proposal_requests[type], this.onProposalResponse);
            });
        }
    }

    @action.bound
    onProposalResponse(response) {
        const contract_type           = response.echo_req.contract_type;
        const prev_proposal_info      = getPropertyValue(this.proposal_info, contract_type) || {};
        const obj_prev_contract_basis = getPropertyValue(prev_proposal_info, 'obj_contract_basis') || {};

        this.proposal_info  = {
            ...this.proposal_info,
            [contract_type]: getProposalInfo(this, response, obj_prev_contract_basis),
        };

        if (!this.smart_chart.is_contract_mode) {
            setChartBarrier(this.smart_chart, response, this.onChartBarrierChange);
        }

        this.is_purchase_enabled = true;
    }

    @action.bound
    onChartBarrierChange(barrier_1, barrier_2) {
        this.processNewValuesAsync({ barrier_1, barrier_2 }, true);
    }

    @action.bound
    updateQueryString() {

        // Update the url's query string by default values of the store
        const query_params = URLHelper.updateQueryString(
            this,
            allowed_query_string_variables,
            this.is_trade_component_mounted,
        );

        // update state values from query string
        const config = {};
        [...query_params].forEach(param => config[param[0]] = param[1]);
        return config;
    }

    @action.bound
    changeDurationValidationRules() {
        if (this.expiry_type === 'endtime') {
            this.validation_errors.duration = [];
            return;
        }

        const index  = this.validation_rules.duration.rules.findIndex(item => item[0] === 'number');
        const limits = this.duration_min_max[this.contract_expiry_type] || false;

        if (limits) {
            const duration_options = {
                min: convertDurationLimit(+limits.min, this.duration_unit),
                max: convertDurationLimit(+limits.max, this.duration_unit),
            };

            if (index > -1) {
                this.validation_rules.duration.rules[index][1] = duration_options;
            } else {
                this.validation_rules.duration.rules.push(['number', duration_options]);
            }
            this.validateProperty('duration', this.duration);
        }
    }

    @action.bound
    changeAllowEquals() {
        const hasCallPutEqual = (contract_type_list) => {
            if (!contract_type_list) return false;

            return getPropertyValue(contract_type_list, 'Up/Down')
                .some(contract => contract.value === 'rise_fall_equal');
        };
        const hasDurationForCallPutEqual = (contract_type_list, duration_unit, contract_start_type) => {
            if (!contract_type_list || !duration_unit || !contract_start_type) return false;

            const contract_list = Object.keys(contract_type_list || {})
                .reduce((key, list) => ([...key, ...contract_type_list[list].map(contract => contract.value)]), []);
            
            const contract_duration_list = contract_list
                .map(list => ({ [list]: getPropertyValue(ContractType.getFullContractTypes(), [list, 'config', 'durations', 'units_display', contract_start_type]) }));

            // Check whether rise fall equal is exists and has the current store duration unit
            return hasCallPutEqual(contract_type_list) ? contract_duration_list
                .filter(contract => contract.rise_fall_equal)[0].rise_fall_equal
                .some(duration => duration.value === duration_unit) : false;
        };
        const check_callput_equal_duration = hasDurationForCallPutEqual(this.contract_types_list,
            this.duration_unit, this.contract_start_type);

        if (!(/^(rise_fall|rise_fall_equal)$/.test(this.contract_type))) {
            this.is_allow_equal = false;
            this.is_equal_checked = 0;
        }

        if (/^(rise_fall|rise_fall_equal)$/.test(this.contract_type) && (check_callput_equal_duration || this.expiry_type === 'endtime') && hasCallPutEqual(this.contract_types_list)) {
            this.is_allow_equal = true;
        } else {
            this.is_allow_equal = false;
        }
    }

    @action.bound
    accountSwitcherListener() {
        return new Promise(async (resolve) => {
            await this.refresh();
            await this.prepareTradeStore();
            return resolve(this.debouncedProposal());
        });
    }

    @action.bound
    async onMount() {
        await this.prepareTradeStore();
        this.debouncedProposal();
        runInAction(() => {
            this.is_trade_component_mounted = true;
        });
        this.updateQueryString();
        this.onSwitchAccount(this.accountSwitcherListener);
    }

    @action.bound
    onUnmount() {
        this.disposeSwitchAccount();
        WS.forgetAll('proposal');
        this.is_trade_component_mounted = false;
    }
}
